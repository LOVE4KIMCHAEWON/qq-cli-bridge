import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CursorAcpClient } from "../src/acp/client.js";
import { ownedChildren } from "../src/lifecycle/child-registry.js";
import { isPidAlive } from "../src/lifecycle/process-info.js";
import { spawnWithPlan, resolveSpawnPlan } from "../src/util/process.js";
import { CursorAgentAcpAdapter } from "../src/adapters/agent-acp.js";
import { createAdapter } from "../src/adapters/registry.js";
import { defaultConfig } from "../src/config/store.js";

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-life-"));
}

/** Minimal NDJSON ACP server script for real process lifecycle tests. */
function writeFakeAcpServer(dir: string): string {
  const file = path.join(dir, "fake-acp-server.mjs");
  fs.writeFileSync(
    file,
    `
import readline from 'node:readline';
let nextSess = 1;
const sessions = new Set();
const rl = readline.createInterface({ input: process.stdin });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') return reply(id, { protocolVersion: 1 });
  if (method === 'authenticate') return reply(id, {});
  if (method === 'session/new') {
    const sid = 's' + (nextSess++);
    sessions.add(sid);
    return reply(id, {
      sessionId: sid,
      configOptions: [
        { configId: 'mode', category: 'mode', currentValue: 'agent' },
        { configId: 'model', category: 'model', currentValue: 'default', options: ['default', 'composer-2.5'] },
      ],
    });
  }
  if (method === 'session/load') {
    const sid = params.sessionId;
    if (!sessions.has(sid)) {
      process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, error:{ code:-32002, message:'unknown' }}) + '\\n');
      return;
    }
    return reply(id, { sessionId: sid, configOptions: [{ configId:'model', category:'model', currentValue:'default' }] });
  }
  if (method === 'session/set_config_option') return reply(id, { configOptions: [] });
  if (method === 'session/prompt') {
    process.stdout.write(JSON.stringify({
      jsonrpc:'2.0', method:'session/update',
      params:{ update:{ sessionUpdate:'agent_message_chunk', content:{ text:'OK' } } }
    }) + '\\n');
    return reply(id, { stopReason: 'end_turn' });
  }
  if (method === 'session/cancel') return;
  if (id != null) reply(id, {});
});
// Stay alive until killed
setInterval(() => {}, 1 << 30);
`,
    "utf8",
  );
  return file;
}

describe("ACP process lifecycle (Windows-capable)", () => {
  let dataDir: string;
  let prev: string | undefined;
  let serverPath: string;

  beforeEach(() => {
    dataDir = tempDataDir();
    prev = process.env.QQBRIDGE_DATA_DIR;
    process.env.QQBRIDGE_DATA_DIR = dataDir;
    serverPath = writeFakeAcpServer(dataDir);
  });

  afterEach(async () => {
    ownedChildren.stopOwned(true);
    await ownedChildren.waitUntilEmpty(3000);
    // Windows may briefly lock the temp dir while the child exits.
    await new Promise((r) => setTimeout(r, 200));
    if (prev === undefined) delete process.env.QQBRIDGE_DATA_DIR;
    else process.env.QQBRIDGE_DATA_DIR = prev;
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("starts and fully stops a real ACP-like child with no orphan pid", async () => {
    const before = new Set(ownedChildren.listAlivePids());
    const client = new CursorAcpClient({
      command: "node",
      cwd: dataDir,
      permissionMode: "reject",
      spawnProcess: async () => {
        const plan = await resolveSpawnPlan("node", [serverPath]);
        return spawnWithPlan(plan, {
          cwd: dataDir,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    });

    await client.start();
    const pid = client.pid;
    assert.ok(pid && isPidAlive(pid), "ACP child should be alive after start");
    assert.ok(ownedChildren.listAlivePids().includes(pid));

    const session = await client.sessionNew(dataDir);
    const out = await client.prompt(session.sessionId, "hi");
    assert.match(out.text, /OK/);

    // Redundant load must be a no-op on live connection
    const loaded = await client.sessionLoad(session.sessionId, dataDir);
    assert.equal(loaded.sessionId, session.sessionId);

    await client.stop();
    assert.equal(isPidAlive(pid!), false, "owned ACP child must be dead after stop");
    const leftover = ownedChildren.listAlivePids().filter((p) => !before.has(p));
    assert.deepEqual(leftover, [], `orphans: ${leftover.join(",")}`);
  });

  it("force-reaps hung child on stop timeout path", async () => {
    const hung = path.join(dataDir, "hung.mjs");
    fs.writeFileSync(
      hung,
      `process.stdin.resume(); setInterval(()=>{}, 1<<30);`,
      "utf8",
    );
    const plan = await resolveSpawnPlan("node", [hung]);
    // cwd outside the temp dataDir so afterEach can delete dataDir even if kill races.
    const child = spawnWithPlan(plan, {
      cwd: os.tmpdir(),
      stdio: ["ignore", "ignore", "ignore"],
    });
    const pid = child.pid!;
    assert.ok(isPidAlive(pid));
    ownedChildren.stopOwned(true);
    const wait = await ownedChildren.waitUntilEmpty(5000);
    assert.equal(wait.remaining.includes(pid), false);
    assert.equal(isPidAlive(pid), false);
  });
});

describe("oneshot bootstrap no longer burns a seed model turn", () => {
  it("returns continue without spawning", async () => {
    const adapter = createAdapter("agent", defaultConfig());
    await adapter.start({ cwd: process.cwd() });
    assert.equal(adapter.getSessionId(), "continue");
    await adapter.stop();
  });
});

describe("duplicate prompt guard (mocked ACP)", () => {
  it("blocks a second concurrent prompt for the same conversation", async () => {
    class SlowFake extends EventEmitter {
      stdin = new PassThrough();
      stdout = new PassThrough();
      stderr = new PassThrough();
      pid = 99901;
      killed = false;
      constructor() {
        super();
        let buf = "";
        this.stdin.on("data", (c) => {
          buf += c.toString();
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            void this.onLine(line);
          }
        });
      }
      kill() {
        this.killed = true;
        this.emit("exit", 0, null);
        return true;
      }
      private reply(id: number, result: unknown) {
        this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
      }
      private async onLine(line: string) {
        const msg = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: { sessionId?: string };
        };
        if (msg.method === "initialize") return this.reply(msg.id!, {});
        if (msg.method === "authenticate") return this.reply(msg.id!, {});
        if (msg.method === "session/new") {
          return this.reply(msg.id!, {
            sessionId: "s1",
            configOptions: [
              { configId: "model", category: "model", currentValue: "default" },
            ],
          });
        }
        if (msg.method === "session/prompt") {
          await new Promise((r) => setTimeout(r, 200));
          this.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { text: "done" },
                },
              },
            }) + "\n",
          );
          return this.reply(msg.id!, { stopReason: "end_turn" });
        }
        if (msg.id != null) this.reply(msg.id, {});
      }
    }

    const fake = new SlowFake();
    const adapter = new CursorAgentAcpAdapter({
      command: "agent",
      permissionMode: "reject",
    });
    const client = new CursorAcpClient({
      command: "agent",
      cwd: process.cwd(),
      spawnProcess: () => fake as never,
    });
    await client.start();
    (adapter as unknown as { client: CursorAcpClient }).client = client;
    (adapter as unknown as { options: { cwd: string } }).options = {
      cwd: process.cwd(),
    };

    const p1 = adapter.sendAndCollect("one", "sess", undefined, {
      conversationId: "c2c:dup",
    });
    const p2 = adapter.sendAndCollect("two", "sess", undefined, {
      conversationId: "c2c:dup",
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    const texts = [r1, r2];
    assert.ok(texts.some((t) => /duplicate prompt blocked/i.test(t)));
    assert.ok(texts.some((t) => /done/i.test(t)));
    await adapter.stop();
  });
});
