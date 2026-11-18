import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSpawnPlan,
  quoteForCmdExe,
  resolveSpawnPlan,
  runCommand,
} from "../src/util/process.js";

describe("Windows spawn planner", () => {
  it("quotes cmd.exe args without concatenating raw shell metacharacters unsafely", () => {
    assert.equal(quoteForCmdExe("simple"), "simple");
    assert.equal(quoteForCmdExe("a b"), '"a b"');
    assert.equal(quoteForCmdExe("x&y"), '"x^&y"');
    assert.equal(quoteForCmdExe(""), '""');
  });

  it("routes .cmd through cmd.exe with windowsVerbatimArguments (EINVAL fix)", () => {
    const cmdPath = "C:\\Users\\example\\AppData\\Local\\cursor-agent\\agent.cmd";
    const plan = buildSpawnPlan("agent", ["-p", "Reply with PONG", "-f"], [cmdPath]);
    assert.equal(plan.strategy, "cmd-batch");
    assert.match(plan.file.toLowerCase(), /cmd\.exe$/);
    assert.deepEqual(plan.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(plan.options.windowsVerbatimArguments, true);
    assert.equal(plan.options.shell, false);
    // User prompt appears as a quoted token inside the cmdline argv element — not shell:true.
    // Outer quotes wrap the whole /c string; prompt stays a quoted token inside.
    assert.match(plan.args[3]!, /^".*"$/);
    assert.match(plan.args[3]!, /Reply with PONG/);
    assert.match(plan.args[3]!, / -p /);
  });

  it("routes .ps1 through powershell -File with separate argv", () => {
    const ps1 = "C:\\Users\\example\\AppData\\Local\\cursor-agent\\agent.ps1";
    const plan = buildSpawnPlan("agent", ["--version"], [ps1]);
    assert.equal(plan.strategy, "powershell-file");
    assert.match(plan.file.toLowerCase(), /powershell\.exe$/);
    assert.deepEqual(plan.args.slice(0, 4), [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
    ]);
    assert.equal(plan.args[4], ps1);
    assert.equal(plan.args[5], "--version");
    assert.equal(plan.options.shell, false);
  });

  it("prefers .exe over .cmd when both exist in candidates", () => {
    const plan = buildSpawnPlan(
      "tool",
      ["a"],
      ["C:\\tools\\tool.cmd", "C:\\tools\\tool.exe"],
    );
    assert.equal(plan.strategy, "direct");
    assert.equal(plan.file, "C:\\tools\\tool.exe");
    assert.deepEqual(plan.args, ["a"]);
  });
});

/**
 * Live: requires the Cursor Agent CLI (`agent`) installed and authenticated, and runs a
 * real prompt. Opt in with QQBRIDGE_LIVE_TESTS=1 (`npm run test:live`).
 */
const liveSkip =
  process.env.QQBRIDGE_LIVE_TESTS === "1" ? false : "live test (set QQBRIDGE_LIVE_TESTS=1)";

describe("Windows agent.cmd regression (live)", { skip: liveSkip }, () => {
  it("spawns Cursor Agent via resolved plan without EINVAL and captures version", async (t) => {
    if (process.platform !== "win32") {
      t.skip("Windows only");
      return;
    }

    const plan = await resolveSpawnPlan("agent", ["--version"]);
    assert.ok(
      plan.strategy === "cmd-batch" || plan.strategy === "powershell-file",
      `unexpected strategy ${plan.strategy}`,
    );

    const result = await runCommand("agent", ["--version"], { timeoutMs: 60_000 });
    assert.equal(result.code, 0, `stderr=${result.stderr}`);
    assert.match(result.stdout + result.stderr, /\d{4}\.\d+\.\d+/);
  });

  it("captures structured JSON from agent -p", async (t) => {
    if (process.platform !== "win32") {
      t.skip("Windows only");
      return;
    }

    const result = await runCommand(
      "agent",
      ["-p", "Reply with exactly PONG and nothing else.", "--output-format", "json", "-f"],
      { cwd: path.join(os.tmpdir()), timeoutMs: 120_000 },
    );
    assert.equal(result.code, 0, `stderr=${result.stderr}\nstdout=${result.stdout}`);
    const jsonLine = result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith("{"));
    assert.ok(jsonLine, "expected JSON line in stdout");
    const obj = JSON.parse(jsonLine!) as { result?: string; session_id?: string };
    assert.match(String(obj.result ?? ""), /PONG/i);
    assert.ok(obj.session_id);
  });
});

describe("fixture batch spawn", () => {
  it("runs a temporary .cmd through cmd-batch strategy", async (t) => {
    if (process.platform !== "win32") {
      t.skip("Windows only");
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-cmd-"));
    const bat = path.join(dir, "echo-args.cmd");
    fs.writeFileSync(
      bat,
      `@echo off\r\necho ARG1=%~1\r\necho ARG2=%~2\r\n`,
      "utf8",
    );
    const plan = buildSpawnPlan(bat, ["hello world", "x&y"], [bat]);
    assert.equal(plan.strategy, "cmd-batch");
    const result = await runCommand(bat, ["hello world", "x&y"], { timeoutMs: 15_000 });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ARG1=hello world/);
    assert.match(result.stdout, /ARG2=x&y/);
  });
});
