import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ClaudeStreamClient } from "../src/claude/stream-client.js";
import { createAdapter } from "../src/adapters/registry.js";
import { defaultConfig } from "../src/config/store.js";
import { ClaudeStreamAdapter } from "../src/adapters/claude-stream.js";

function fakeClaudeProcess(script: (stdinLine: string, write: (obj: unknown) => void) => void) {
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
      script(line, (obj) => {
        stdout.write(JSON.stringify(obj) + "\n");
      });
    }
  });
  return {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    killed: false,
    kill: () => {
      (ee as EventEmitter).emit("exit", 0, null);
      return true;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => ee.on(event, listener),
    once: (event: string, listener: (...args: unknown[]) => void) => ee.once(event, listener),
  };
}

describe("ClaudeStreamClient — process reuse", () => {
  it("handles two prompts on one process without respawn", async () => {
    let spawnCount = 0;
    let turns = 0;
    const client = new ClaudeStreamClient({
      command: "claude",
      cwd: process.cwd(),
      spawnProcess: async () => {
        spawnCount++;
        return fakeClaudeProcess((_line, write) => {
          turns++;
          const sid = "sess-claude-1";
          write({ type: "system", subtype: "init", session_id: sid });
          write({
            type: "assistant",
            session_id: sid,
            message: {
              role: "assistant",
              content: [{ type: "text", text: turns === 1 ? "PONG1" : "PONG2" }],
            },
          });
          write({
            type: "result",
            session_id: sid,
            result: turns === 1 ? "PONG1" : "PONG2",
            usage: { input_tokens: 10, output_tokens: 2 },
          });
        });
      },
    });

    await client.start();
    const r1 = await client.prompt("ping1");
    const r2 = await client.prompt("ping2");
    assert.equal(spawnCount, 1);
    assert.equal(r1.text, "PONG1");
    assert.equal(r2.text, "PONG2");
    assert.equal(r1.sessionId, "sess-claude-1");
    assert.equal(client.pid, 4242);
    await client.stop();
  });

  it("isolates missing assistant into empty text (no raw JSON)", async () => {
    const client = new ClaudeStreamClient({
      command: "claude",
      cwd: process.cwd(),
      spawnProcess: async () =>
        fakeClaudeProcess((_line, write) => {
          write({ type: "system", subtype: "init", session_id: "s" });
          write({ type: "result", session_id: "s", result: "" });
        }),
    });
    await client.start();
    const r = await client.prompt("x");
    assert.equal(r.text, "");
    assert.doesNotMatch(r.text, /\{"type":/);
    await client.stop();
  });
});

describe("Claude registry transport selection", () => {
  it("defaults to stream ClaudeStreamAdapter for QQ chat", () => {
    const cfg = defaultConfig();
    const adapter = createAdapter("claude", cfg);
    assert.ok(adapter instanceof ClaudeStreamAdapter);
    assert.equal(adapter.displayName, "Claude Code (stream)");
  });

  it("selects oneshot when transport=oneshot", () => {
    const cfg = defaultConfig();
    cfg.agents.claude.transport = "oneshot";
    const adapter = createAdapter("claude", cfg);
    assert.equal(adapter.displayName, "Claude Code");
  });
});
