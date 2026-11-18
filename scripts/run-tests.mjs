#!/usr/bin/env node
/**
 * Offline test runner.
 *
 * - Points QQBRIDGE_DATA_DIR at a fresh temporary directory so tests can never
 *   read or modify a real data/ directory (credentials, Memory, Persona, ...).
 * - Live tests that call real AI CLIs are skipped unless QQBRIDGE_LIVE_TESTS=1
 *   (use `npm run test:live`). Codex live probes additionally require
 *   QQBRIDGE_CODEX_LIVE_VERIFY=1.
 *
 * Extra arguments are forwarded to `node --test` (e.g. a file path).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
if (!fs.existsSync(tsxCli)) {
  console.error("tsx is not installed. Run `npm ci` first.");
  process.exit(1);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-test-data-"));
const env = { ...process.env, QQBRIDGE_DATA_DIR: dataDir };
delete env.QQBRIDGE_PERSONA_PATH;
if (!env.QQBRIDGE_LIVE_TESTS) env.QQBRIDGE_LIVE_TESTS = "0";

const extra = process.argv.slice(2);
const targets = extra.length ? extra : ["test/**/*.test.ts"];

console.log(`[run-tests] isolated QQBRIDGE_DATA_DIR=${dataDir}`);
console.log(`[run-tests] live tests: ${env.QQBRIDGE_LIVE_TESTS === "1" ? "ENABLED" : "skipped"}`);

const child = spawn(process.execPath, [tsxCli, "--test", ...targets], {
  cwd: root,
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Windows may hold SQLite handles briefly; leftover temp dirs are harmless.
  }
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
