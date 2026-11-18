import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ClaudeStreamClient } from "../src/claude/stream-client.js";
import {
  assertClaudeChatOnlyArgsSafe,
  claudeChatOnlyArgs,
} from "../src/security/chat-only.js";

function fakeProcess(opts: {
  onStart?: (writeErr: (s: string) => void, writeOut: (obj: unknown) => void) => void;
  exitImmediately?: { code: number; stderr: string };
  multiTurn?: boolean;
}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const ee = new EventEmitter();
  let buf = "";
  let turns = 0;
  let pid = 7777;

  const writeOut = (obj: unknown) => {
    stdout.write(JSON.stringify(obj) + "\n");
  };
  const writeErr = (s: string) => {
    stderr.write(s + "\n");
  };

  if (opts.exitImmediately) {
    setTimeout(() => {
      writeErr(opts.exitImmediately!.stderr);
      ee.emit("exit", opts.exitImmediately!.code, null);
    }, 10);
  } else {
    stdin.on("data", (chunk: Buffer | string) => {
      buf += String(chunk);
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        turns++;
        const sid = "sess-stable";
        writeOut({ type: "system", subtype: "init", session_id: sid });
        writeOut({
          type: "assistant",
          session_id: sid,
          message: {
            role: "assistant",
            content: [{ type: "text", text: `PONG${turns}` }],
          },
        });
        writeOut({
          type: "result",
          session_id: sid,
          result: `PONG${turns}`,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
    });
    opts.onStart?.(writeErr, writeOut);
  }

  return {
    stdin,
    stdout,
    stderr,
    pid,
    killed: false,
    kill: () => {
      ee.emit("exit", 0, null);
      return true;
    },
    on: (e: string, l: (...a: unknown[]) => void) => ee.on(e, l),
    once: (e: string, l: (...a: unknown[]) => void) => ee.once(e, l),
    getTurns: () => turns,
  };
}

describe("Claude chat-only argv — MCP config regression", () => {
  it("rejects the broken {} mcp-config that crashed stream", () => {
    assert.throws(
      () => assertClaudeChatOnlyArgsSafe(["--tools", "", "--mcp-config", "{}"]),
      /mcpServers/,
    );
  });

  it("accepts current claudeChatOnlyArgs()", () => {
    assert.doesNotThrow(() => assertClaudeChatOnlyArgsSafe(claudeChatOnlyArgs()));
    const mcp = claudeChatOnlyArgs()[claudeChatOnlyArgs().indexOf("--mcp-config") + 1]!;
    assert.match(mcp, /"mcpServers"/);
  });
});

describe("ClaudeStreamClient — invalid MCP config exit", () => {
  it("fails start safely without leaking raw MCP schema to callers", async () => {
    const client = new ClaudeStreamClient({
      command: "claude",
      cwd: process.cwd(),
      spawnProcess: async () =>
        fakeProcess({
          exitImmediately: {
            code: 1,
            stderr:
              "Error: Invalid MCP configuration:\nmcpServers: Invalid input: expected record, received undefined",
          },
        }),
    });
    await assert.rejects(
      () => client.start(),
      (err: Error) => {
        assert.match(err.message, /invalid MCP configuration/i);
        assert.doesNotMatch(err.message, /expected record/);
        return true;
      },
    );
    await client.stop();
  });
});

describe("ClaudeStreamClient — multi-turn process reuse", () => {
  it("completes first prompt and reuses process for three more turns", async () => {
    let spawnCount = 0;
    let fake: ReturnType<typeof fakeProcess>;
    const client = new ClaudeStreamClient({
      command: "claude",
      cwd: process.cwd(),
      spawnProcess: async () => {
        spawnCount++;
        fake = fakeProcess({ multiTurn: true });
        return fake;
      },
    });
    await client.start();
    const r1 = await client.prompt("a");
    const r2 = await client.prompt("b");
    const r3 = await client.prompt("c");
    const r4 = await client.prompt("d");
    assert.equal(spawnCount, 1);
    assert.equal(fake!.getTurns(), 4);
    assert.equal(r1.text, "PONG1");
    assert.equal(r2.text, "PONG2");
    assert.equal(r3.text, "PONG3");
    assert.equal(r4.text, "PONG4");
    assert.equal(client.pid, 7777);
    await client.stop();
  });
});
