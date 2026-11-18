import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ClaudeStreamClient } from "../src/claude/stream-client.js";
import { CodexAppServerClient } from "../src/codex/app-server-client.js";
import { isPidAlive } from "../src/lifecycle/process-info.js";
import { ownedChildren } from "../src/lifecycle/child-registry.js";
import { resolveSpawnPlan, spawnWithPlan } from "../src/util/process.js";
import type { ChildProcess } from "node:child_process";

describe("Persistent client clean shutdown (mocked)", () => {
  it("ClaudeStreamClient stop clears active state", async () => {
    const ee = new EventEmitter();
    const client = new ClaudeStreamClient({
      command: "claude",
      cwd: process.cwd(),
      spawnProcess: async () => ({
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 9001,
        killed: false,
        kill: () => {
          ee.emit("exit", 0, null);
          return true;
        },
        on: (e: string, l: (...a: unknown[]) => void) => ee.on(e, l),
        once: (e: string, l: (...a: unknown[]) => void) => ee.once(e, l),
      }),
    });
    await client.start();
    assert.equal(client.isReady, true);
    await client.stop();
    assert.equal(client.isReady, false);
  });

  it("CodexAppServerClient stop clears ready flag", async () => {
    const ee = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdin.on("data", (chunk: Buffer | string) => {
      const line = String(chunk).trim();
      if (!line) return;
      const msg = JSON.parse(line) as { id?: number; method?: string };
      if (msg.method === "initialize") {
        stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
      }
    });
    const client = new CodexAppServerClient({
      command: "codex",
      cwd: process.cwd(),
      spawnProcess: async () => ({
        stdin,
        stdout,
        stderr: new PassThrough(),
        pid: 9002,
        killed: false,
        kill: () => {
          ee.emit("exit", 0, null);
          return true;
        },
        on: (e: string, l: (...a: unknown[]) => void) => ee.on(e, l),
        once: (e: string, l: (...a: unknown[]) => void) => ee.once(e, l),
      }),
    });
    await client.start();
    assert.equal(client.isReady, true);
    await client.stop();
    assert.equal(client.isReady, false);
  });
});

describe("Windows process-level lifecycle (real short-lived child)", () => {
  it("tracks and stops an owned node child without orphans", async () => {
    const plan = await resolveSpawnPlan(process.execPath, [
      "-e",
      "setInterval(()=>{}, 1000)",
    ]);
    const child = spawnWithPlan(plan, {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcess;
    ownedChildren.track(child);
    const pid = child.pid;
    assert.ok(pid);
    assert.equal(isPidAlive(pid!), true);
    ownedChildren.stopOwned(true);
    await ownedChildren.waitUntilEmpty(5000);
    assert.equal(isPidAlive(pid!), false);
  });
});
