import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexAppServerClient } from "../src/codex/app-server-client.js";
import { createAdapter } from "../src/adapters/registry.js";
import { defaultConfig } from "../src/config/store.js";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

function fakeAppServer() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const ee = new EventEmitter();
  let buf = "";
  let turnCount = 0;

  const write = (obj: unknown) => {
    stdout.write(JSON.stringify(obj) + "\n");
  };

  stdin.on("data", (chunk: Buffer | string) => {
    buf += String(chunk);
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (msg.method === "initialize") {
        write({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
      } else if (msg.method === "thread/start") {
        write({
          jsonrpc: "2.0",
          id: msg.id,
          result: { thread: { id: "thread-1" } },
        });
        write({
          jsonrpc: "2.0",
          method: "thread/started",
          params: { thread: { id: "thread-1" } },
        });
      } else if (msg.method === "thread/resume") {
        write({
          jsonrpc: "2.0",
          id: msg.id,
          result: { thread: { id: msg.params?.threadId ?? "thread-1" } },
        });
      } else if (msg.method === "turn/start") {
        turnCount++;
        const turnId = `turn-${turnCount}`;
        write({
          jsonrpc: "2.0",
          id: msg.id,
          result: { turn: { id: turnId, status: "inProgress" } },
        });
        write({ jsonrpc: "2.0", method: "turn/started", params: { turn: { id: turnId } } });
        const text = turnCount === 1 ? "APP_PONG" : "APP_PONG2";
        write({
          jsonrpc: "2.0",
          method: "item/agentMessage/delta",
          params: { delta: text.slice(0, 3) },
        });
        write({
          jsonrpc: "2.0",
          method: "item/agentMessage/delta",
          params: { delta: text.slice(3) },
        });
        write({
          jsonrpc: "2.0",
          method: "item/completed",
          params: {
            item: { type: "agentMessage", text, phase: "final_answer" },
          },
        });
        write({
          jsonrpc: "2.0",
          method: "thread/tokenUsage/updated",
          params: {
            tokenUsage: {
              last: {
                inputTokens: 100,
                cachedInputTokens: 40,
                outputTokens: 5,
                reasoningOutputTokens: 2,
              },
            },
          },
        });
        write({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { turn: { id: turnId, status: "completed" } },
        });
      } else if (msg.method === "model/list") {
        write({
          jsonrpc: "2.0",
          id: msg.id,
          result: { models: [{ id: "gpt-5.3-codex", name: "GPT" }] },
        });
      } else if (msg.id != null) {
        write({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
    }
  });

  return {
    stdin,
    stdout,
    stderr,
    pid: 5252,
    killed: false,
    kill: () => {
      ee.emit("exit", 0, null);
      return true;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => ee.on(event, listener),
    once: (event: string, listener: (...args: unknown[]) => void) => ee.once(event, listener),
    getTurnCount: () => turnCount,
  };
}

describe("CodexAppServerClient — process reuse + parsing", () => {
  it("reuses one process across two turns and extracts assistant text only", async () => {
    let spawnCount = 0;
    let fake: ReturnType<typeof fakeAppServer>;
    const client = new CodexAppServerClient({
      command: "codex",
      cwd: process.cwd(),
      spawnProcess: async () => {
        spawnCount++;
        fake = fakeAppServer();
        return fake;
      },
    });

    await client.start();
    const { threadId } = await client.threadStart();
    const r1 = await client.turnStart(threadId, "ping1");
    const r2 = await client.turnStart(threadId, "ping2");

    assert.equal(spawnCount, 1);
    assert.equal(fake!.getTurnCount(), 2);
    assert.equal(r1.text, "APP_PONG");
    assert.equal(r2.text, "APP_PONG2");
    assert.equal(r1.usage?.inputTokens, 100);
    assert.equal(r1.usage?.cachedInputTokens, 40);
    assert.doesNotMatch(r1.text, /jsonrpc|turn\/completed|thread\//);
    await client.stop();
  });

  it("rejects approval server requests without hanging", async () => {
    const client = new CodexAppServerClient({
      command: "codex",
      cwd: process.cwd(),
      spawnProcess: async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const ee = new EventEmitter();
        let buf = "";
        stdin.on("data", (chunk: Buffer | string) => {
          buf += String(chunk);
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            const msg = JSON.parse(line) as { id?: number; method?: string };
            if (msg.method === "initialize") {
              stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
              // Server request for approval
              stdout.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 99,
                  method: "execCommandApproval",
                  params: { command: "rm -rf /" },
                }) + "\n",
              );
            } else if (msg.id === 99 || (msg as { error?: unknown }).error) {
              // client responded with error — ok
            } else if (msg.id != null) {
              stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
            }
          }
        });
        return {
          stdin,
          stdout,
          stderr,
          pid: 1,
          killed: false,
          kill: () => {
            ee.emit("exit", 0, null);
            return true;
          },
          on: (e: string, l: (...a: unknown[]) => void) => ee.on(e, l),
          once: (e: string, l: (...a: unknown[]) => void) => ee.once(e, l),
        };
      },
    });
    await client.start();
    await new Promise((r) => setTimeout(r, 50));
    await client.stop();
  });
});

describe("Codex registry transport selection", () => {
  it("defaults to oneshot CodexAdapter", () => {
    const cfg = defaultConfig();
    const adapter = createAdapter("codex", cfg);
    assert.equal(adapter.displayName, "Codex CLI");
  });

  it("selects app-server adapter when transport=app-server", () => {
    const cfg = defaultConfig();
    cfg.agents.codex.transport = "app-server";
    const adapter = createAdapter("codex", cfg);
    assert.ok(adapter instanceof CodexAppServerAdapter);
  });
});
