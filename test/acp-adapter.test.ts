import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CursorAcpClient } from "../src/acp/client.js";
import {
  getAcpSession,
  setAcpSession,
  clearAcpSession,
} from "../src/acp/session-store.js";
import { createAdapter } from "../src/adapters/registry.js";
import { defaultConfig, saveConfig } from "../src/config/store.js";
import { MessageDeduper } from "../src/bridge/message-dedupe.js";
import { TurnReplyGate } from "../src/bridge/pipeline-trace.js";

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-acp-"));
}

class FakeAcpProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  killed = false;
  private sessions = new Map<string, { model?: string }>();
  private nextSession = 1;
  crashOnPrompt = false;
  /** When true, reject a tool and emit no assistant text. */
  permissionOnlyNoText = false;
  permissionCalls = 0;

  constructor() {
    super();
    let buf = "";
    this.stdin.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) void this.onLine(line.trim());
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", 1, null);
    this.stdout.end();
    return true;
  }

  private reply(id: number | string, result: unknown): void {
    this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  private async onLine(line: string): Promise<void> {
    const msg = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    const { id, method, params } = msg;
    if (method === "initialize") {
      this.reply(id!, { protocolVersion: 1 });
      return;
    }
    if (method === "authenticate") {
      this.reply(id!, { authenticated: true });
      return;
    }
    if (method === "session/new") {
      const sid = `acp-sess-${this.nextSession++}`;
      this.sessions.set(sid, {});
      this.reply(id!, {
        sessionId: sid,
        configOptions: [
          {
            configId: "model",
            category: "model",
            currentValue: "auto",
            options: ["auto", "composer-2.5"],
          },
        ],
      });
      return;
    }
    if (method === "session/load") {
      const sid = String(params?.sessionId ?? "");
      if (!this.sessions.has(sid)) {
        this.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32002, message: "unknown session" },
          }) + "\n",
        );
        return;
      }
      this.reply(id!, {
        sessionId: sid,
        configOptions: [
          {
            configId: "model",
            category: "model",
            currentValue: this.sessions.get(sid)?.model ?? "auto",
            options: ["auto", "composer-2.5"],
          },
        ],
      });
      return;
    }
    if (method === "session/set_config_option") {
      const sid = String(params?.sessionId ?? "");
      const value = String(params?.value ?? "");
      const s = this.sessions.get(sid);
      if (!s) {
        this.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32002, message: "unknown session" },
          }) + "\n",
        );
        return;
      }
      if (value !== "auto" && value !== "composer-2.5") {
        this.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `Invalid model value: ${value}` },
          }) + "\n",
        );
        return;
      }
      s.model = value;
      this.reply(id!, {
        configOptions: [
          {
            configId: "model",
            category: "model",
            currentValue: value,
            options: ["auto", "composer-2.5"],
          },
        ],
      });
      return;
    }
    if (method === "session/prompt") {
      const sid = String(params?.sessionId ?? "");
      if (this.crashOnPrompt) {
        this.kill();
        return;
      }
      this.permissionCalls++;
      this.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 9000 + this.permissionCalls,
          method: "session/request_permission",
          params: { toolCallId: "shell-1" },
        }) + "\n",
      );
      await new Promise((r) => setTimeout(r, 20));
      if (!this.permissionOnlyNoText) {
        const model = this.sessions.get(sid)?.model ?? "auto";
        this.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text: `pong:${model}` },
              },
            },
          }) + "\n",
        );
      }
      this.reply(id!, { stopReason: "end_turn" });
      return;
    }
    if (id != null) this.reply(id, {});
  }
}

describe("ACP session store isolation", () => {
  let dataDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dataDir = tempDataDir();
    prev = process.env.QQBRIDGE_DATA_DIR;
    process.env.QQBRIDGE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.QQBRIDGE_DATA_DIR;
    else process.env.QQBRIDGE_DATA_DIR = prev;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps per-conversation ACP sessions separate from oneshot ids", () => {
    setAcpSession("c2c:a", { acpSessionId: "s-a", cwd: "/tmp" });
    setAcpSession("c2c:b", { acpSessionId: "s-b", cwd: "/tmp" });
    assert.equal(getAcpSession("c2c:a")?.acpSessionId, "s-a");
    assert.equal(getAcpSession("c2c:b")?.acpSessionId, "s-b");
    clearAcpSession("c2c:a");
    assert.equal(getAcpSession("c2c:a"), undefined);
    assert.equal(getAcpSession("c2c:b")?.acpSessionId, "s-b");
  });
});

describe("CursorAcpClient with fake process", () => {
  let dataDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dataDir = tempDataDir();
    prev = process.env.QQBRIDGE_DATA_DIR;
    process.env.QQBRIDGE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.QQBRIDGE_DATA_DIR;
    else process.env.QQBRIDGE_DATA_DIR = prev;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("initializes, creates sessions, prompts, rejects permissions, switches model", async () => {
    const fake = new FakeAcpProcess();
    const client = new CursorAcpClient({
      command: "agent",
      cwd: process.cwd(),
      permissionMode: "reject",
      spawnProcess: () => fake,
    });
    const { initMs } = await client.start();
    assert.ok(initMs >= 0);
    const a = await client.sessionNew(process.cwd());
    const b = await client.sessionNew(process.cwd());
    assert.notEqual(a.sessionId, b.sessionId);

    await client.setModel(a.sessionId, "composer-2.5");
    const out = await client.prompt(a.sessionId, "hi");
    assert.match(out.text, /pong:composer-2\.5/);
    assert.doesNotMatch(out.text, /ACP tools rejected/i);
    assert.doesNotMatch(out.text, /\[ACP/i);
    assert.equal(fake.permissionCalls, 1);

    await assert.rejects(client.setModel(a.sessionId, "nope-model"), /refused model/);

    // session restore
    const loaded = await client.sessionLoad(a.sessionId, process.cwd());
    assert.equal(loaded.sessionId, a.sessionId);

    await client.stop();
    assert.equal(fake.killed, true);
  });

  it("marks unknown completion on crash and does not auto-replay", async () => {
    const fake = new FakeAcpProcess();
    const client = new CursorAcpClient({
      command: "agent",
      cwd: process.cwd(),
      permissionMode: "reject",
      spawnProcess: () => fake,
    });
    await client.start();
    const s = await client.sessionNew(process.cwd());
    fake.crashOnPrompt = true;
    await assert.rejects(client.prompt(s.sessionId, "boom"));
    assert.equal(client.lastTurnCompletionUnknown, true);

    // Recovery requires explicit clear + restart; still must not silently replay
    await assert.rejects(
      client.prompt(s.sessionId, "again"),
      /not auto-replaying|not ready|unknown completion/i,
    );
  });

  it("does not leak ACP permission diagnostics into QQ-visible reply text", async () => {
    const fake = new FakeAcpProcess();
    const client = new CursorAcpClient({
      command: "agent",
      cwd: process.cwd(),
      permissionMode: "reject",
      spawnProcess: () => fake,
    });
    await client.start();
    const s = await client.sessionNew(process.cwd());
    const out = await client.prompt(s.sessionId, "hi");
    assert.equal(out.text, "pong:auto");
    assert.doesNotMatch(out.text, /ACP tools rejected/i);
    assert.doesNotMatch(out.text, /shell-1/);
    assert.doesNotMatch(out.text, /reject-once/i);
    assert.doesNotMatch(out.text, /session\/request_permission/i);
    assert.doesNotMatch(out.text, /\[ACP/i);
    await client.stop();
  });

  it("returns a user-friendly message when tools are rejected and there is no assistant text", async () => {
    const fake = new FakeAcpProcess();
    fake.permissionOnlyNoText = true;
    const client = new CursorAcpClient({
      command: "agent",
      cwd: process.cwd(),
      permissionMode: "reject",
      spawnProcess: () => fake,
    });
    await client.start();
    const s = await client.sessionNew(process.cwd());
    const out = await client.prompt(s.sessionId, "run something");
    assert.match(out.text, /tool use is disabled/i);
    assert.doesNotMatch(out.text, /ACP tools rejected/i);
    assert.doesNotMatch(out.text, /shell-1/);
    assert.doesNotMatch(out.text, /\[ACP/i);
    await client.stop();
  });

  it("chat-only forces reject even when allow-once is requested", async () => {
    const fake = new FakeAcpProcess();
    const written: string[] = [];
    const origWrite = fake.stdin.write.bind(fake.stdin);
    fake.stdin.write = ((chunk: string | Buffer, ...rest: unknown[]) => {
      written.push(chunk.toString());
      return origWrite(chunk, ...(rest as []));
    }) as typeof fake.stdin.write;

    const client = new CursorAcpClient({
      command: "agent",
      cwd: process.cwd(),
      permissionMode: "allow-once",
      spawnProcess: () => fake,
    });
    await client.start();
    const s = await client.sessionNew(process.cwd());
    await client.prompt(s.sessionId, "hi");
    assert.ok(written.some((w) => w.includes("reject-once")));
    assert.equal(written.some((w) => w.includes('"optionId":"allow-once"')), false);
    await client.stop();
  });
});

describe("registry transport selection + oneshot fallback", () => {
  let dataDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dataDir = tempDataDir();
    prev = process.env.QQBRIDGE_DATA_DIR;
    process.env.QQBRIDGE_DATA_DIR = dataDir;
    saveConfig(defaultConfig());
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.QQBRIDGE_DATA_DIR;
    else process.env.QQBRIDGE_DATA_DIR = prev;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("defaults to oneshot CursorAgentAdapter", () => {
    const adapter = createAdapter("agent", defaultConfig());
    assert.equal(adapter.displayName, "Cursor Agent");
  });

  it("selects ACP adapter when transport=acp", () => {
    const cfg = defaultConfig();
    cfg.agents.agent.transport = "acp";
    const adapter = createAdapter("agent", cfg);
    assert.equal(adapter.displayName, "Cursor Agent (ACP)");
  });
});

describe("no duplicate QQ replies under turn gate", () => {
  it("still allows only one outbound with ACP-like double finals", () => {
    const gate = new TurnReplyGate();
    gate.noteFinal();
    gate.noteFinal();
    assert.equal(gate.trySend(), true);
    assert.equal(gate.trySend(), false);
  });

  it("dedupes message ids for slash and normal alike", () => {
    const d = new MessageDeduper({ windowMs: 60_000 });
    const id = {
      messageId: "m-acp-1",
      conversationId: "c2c:u",
      timestamp: "t1",
    };
    assert.equal(d.tryClaim(id).result, "claimed");
    assert.equal(d.tryClaim(id).result, "duplicate");
  });
});
