/**
 * Hold the instance lock, then attempt `qqbridge agent --no-terminal`.
 * Expect a clear rejection without starting a second QQ session.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireInstanceLock, releaseInstanceLock } from "../dist/lifecycle/instance-lock.js";
import { loadCredentials } from "../dist/security/secrets.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const creds = loadCredentials();
if (!creds) {
  console.error("No QQ credentials — run qqbridge setup first");
  process.exit(2);
}

acquireInstanceLock({ appId: creds.appId, agent: "verify-holder" });
console.log(`[holder] lock acquired pid=${process.pid}`);

const child = spawn(process.execPath, [path.join(root, "dist", "cli.js"), "agent", "--no-terminal"], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
child.stdout.on("data", (b) => (out += b.toString()));
child.stderr.on("data", (b) => (out += b.toString()));

const code = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // ignore
    }
    resolve(-1);
  }, 15_000);
  child.on("close", (c) => {
    clearTimeout(timer);
    resolve(c);
  });
});
releaseInstanceLock();

console.log(out.trim());
console.log(`[holder] second instance exit code=${code}`);

if (code === 0 || !/already running/i.test(out)) {
  console.error("FAIL: expected second instance to be rejected");
  process.exit(1);
}
console.log("PASS: second instance rejected with clear error");
