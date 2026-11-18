import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

describe("instance lock lifecycle", () => {
  let dataDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-lock-"));
    prevDataDir = process.env.QQBRIDGE_DATA_DIR;
    process.env.QQBRIDGE_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (prevDataDir === undefined) delete process.env.QQBRIDGE_DATA_DIR;
    else process.env.QQBRIDGE_DATA_DIR = prevDataDir;
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function loadLock() {
    const id = Date.now() + Math.random();
    return import(`../src/lifecycle/instance-lock.js?t=${id}`);
  }

  async function loadProcessInfo() {
    const id = Date.now() + Math.random();
    return import(`../src/lifecycle/process-info.js?t=${id}`);
  }

  it("acquires and releases a cross-process lock directory", async () => {
    const lock = await loadLock();
    const owner = lock.acquireInstanceLock({ appId: "app-1", agent: "agent" });
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.appId, "app-1");
    assert.ok(fs.existsSync(lock.instanceLockDir()));
    lock.releaseInstanceLock();
    assert.equal(fs.existsSync(lock.instanceLockDir()), false);
  });

  it("rejects a second acquire while another qqbridge-like holder is alive", async () => {
    const keeperScript = path.join(dataDir, "qqbridge-keeper.js");
    fs.writeFileSync(
      keeperScript,
      `
const fs = require('fs');
const path = require('path');
const dataDir = ${JSON.stringify(dataDir)};
const dir = path.join(dataDir, 'state', 'instance.lock');
fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({
  v: 1,
  pid: process.pid,
  appId: 'app-1',
  startedAt: new Date().toISOString(),
  startedAtMs: Date.now(),
  hostname: 'test',
  cwd: process.cwd(),
  agent: 'agent'
}));
console.log('ready:' + process.pid);
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const keeper = await new Promise<{ pid: number; kill: () => void }>((resolve, reject) => {
      const child = spawn(process.execPath, [keeperScript], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      const timer = setTimeout(() => reject(new Error("keeper timeout")), 8000);
      child.stdout?.on("data", (b) => {
        out += b.toString();
        if (out.includes("ready:") && child.pid) {
          clearTimeout(timer);
          resolve({
            pid: child.pid,
            kill: () => {
              try {
                child.kill();
              } catch {
                // ignore
              }
            },
          });
        }
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    try {
      const lock = await loadLock();
      await assert.rejects(
        async () => lock.acquireInstanceLock({ appId: "app-1", agent: "claude" }),
        (err: unknown) =>
          err instanceof Error &&
          /already running/i.test(err.message) &&
          err.message.includes(String(keeper.pid)),
      );
    } finally {
      keeper.kill();
      await new Promise((r) => setTimeout(r, 400));
      const lock = await loadLock();
      const result = await lock.stopLockOwner({});
      assert.equal(result.stopped, true);
    }
  });

  it("reclaims lock when owner pid is dead (stale)", async () => {
    const lock = await loadLock();
    const dir = path.join(dataDir, "state", "instance.lock");
    fs.mkdirSync(path.join(dataDir, "state"), { recursive: true });
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "owner.json"),
      JSON.stringify({
        v: 1,
        pid: 999_999_991,
        appId: "app-1",
        startedAt: new Date().toISOString(),
        startedAtMs: Date.now() - 60_000,
        hostname: "test",
        cwd: dataDir,
        agent: "agent",
      }),
      "utf8",
    );

    const owner = lock.acquireInstanceLock({ appId: "app-1", agent: "agent" });
    assert.equal(owner.pid, process.pid);
    lock.releaseInstanceLock();
  });

  it("keeps lock for the live current process (not stale merely for being quiet)", async () => {
    const info = await loadProcessInfo();
    const status = info.isLockOwnerActive({
      pid: process.pid,
      startedAtMs: Date.now() - 1000,
    });
    assert.equal(status.active, true);
  });

  it("detects qqbridge vs unrelated command lines", async () => {
    const info = await loadProcessInfo();
    assert.equal(
      info.looksLikeQqbridgeProcess(
        String.raw`node.exe C:\src\qq-cli-bridge\dist\cli.js agent --no-terminal`,
      ),
      true,
    );
    assert.equal(
      info.looksLikeQqbridgeProcess(
        String.raw`C:\Users\example\AppData\Local\cursor-agent\agent.cmd -p hi`,
      ),
      false,
    );
  });

  it("same process may re-enter the lock it already owns", async () => {
    const lock = await loadLock();
    const a = lock.acquireInstanceLock({ appId: "app-1", agent: "agent" });
    const b = lock.acquireInstanceLock({ appId: "app-1", agent: "gemini" });
    assert.equal(a.pid, process.pid);
    assert.equal(b.pid, process.pid);
    lock.releaseInstanceLock();
  });
});
