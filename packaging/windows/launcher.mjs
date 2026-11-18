#!/usr/bin/env node
/**
 * QQ CLI Bridge — Windows first-run wizard and menu (portable release).
 *
 * Runs on the bundled Node.js. Talks to the Bridge only through its own CLI
 * (app/dist/cli.js) and read-only helpers from app/dist, so every security
 * check (Chat-only policy, restricted Codex verification, encrypted
 * credentials) is the same code path as `qqbridge.cmd`.
 *
 * Never prints secrets: QQ AppSecret is handled entirely by `qqbridge setup`,
 * and agent auth checks only report logged-in / not logged-in.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const bundleDir = path.resolve(appDir, "..");
const cliJs = path.join(appDir, "dist", "cli.js");
const ddgsScript = path.join(appDir, "scripts", "ddgs_images.py");
const version = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")).version;

if (!process.env.QQBRIDGE_DATA_DIR) {
  const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || bundleDir, "AppData", "Local");
  process.env.QQBRIDGE_DATA_DIR = path.join(base, "qq-cli-bridge", "data");
}
if (!process.env.QQBRIDGE_DDGS_PYTHON) {
  process.env.QQBRIDGE_DDGS_PYTHON = path.join(bundleDir, "runtime", "python", "python.exe");
}
const dataDir = path.resolve(process.env.QQBRIDGE_DATA_DIR);
const launcherStatePath = path.join(dataDir, "state", "launcher.json");

const BACKENDS = {
  claude: {
    label: "Claude Code (recommended)",
    transport: "stream",
    install: "https://docs.anthropic.com/en/docs/claude-code — install, then run `claude` once and log in",
  },
  codex: {
    label: "Codex CLI (restricted App Server, hosted web search)",
    transport: "app-server",
    install: "https://github.com/openai/codex — install, then run `codex login`",
  },
};

// ---------------------------------------------------------------- helpers

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
const ok = (s) => console.log(`  ${c.green("[ OK ]")} ${s}`);
const warn = (s) => console.log(`  ${c.yellow("[WARN]")} ${s}`);
const fail = (s) => console.log(`  ${c.red("[FAIL]")} ${s}`);
const info = (s) => console.log(`         ${s}`);

// Input handling.
// - Console (TTY): a fresh readline per question, closed before any child runs, so
//   the child gets a normal console (line mode, Ctrl+C delivered to it).
// - Piped stdin (scripts, tests): one shared line queue, because a per-question
//   interface would swallow the remaining buffered lines.
let pipeRl;
const pipeQueue = [];
let pipeWaiter = null;
let inputClosed = false;
function ensurePipeReader() {
  if (pipeRl) return;
  pipeRl = readline.createInterface({ input: process.stdin, terminal: false });
  pipeRl.on("line", (l) => {
    if (pipeWaiter) {
      const w = pipeWaiter;
      pipeWaiter = null;
      w(l);
    } else pipeQueue.push(l);
  });
  pipeRl.on("close", () => {
    inputClosed = true;
    if (pipeWaiter) {
      const w = pipeWaiter;
      pipeWaiter = null;
      w(null);
    }
  });
}
async function ask(question, def = "") {
  if (!process.stdin.isTTY) {
    ensurePipeReader();
    process.stdout.write(question);
    const line = pipeQueue.length ? pipeQueue.shift() : inputClosed ? null : await new Promise((r) => (pipeWaiter = r));
    process.stdout.write(line === null ? "\n" : `${line}\n`);
    return line === null ? def : line.trim() || def;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(question)).trim();
    return a || def;
  } catch {
    inputClosed = true;
    return def;
  } finally {
    rl.close();
  }
}
const noMoreInput = () => inputClosed && pipeQueue.length === 0;
async function confirm(question, defYes = true) {
  const a = (await ask(`${question} ${defYes ? "[Y/n]" : "[y/N]"} `, defYes ? "y" : "n")).toLowerCase();
  return a.startsWith("y");
}

/** Run the Bridge CLI with inherited console (QR codes, logs). Ctrl+C goes to the child. */
function runCli(args) {
  pipeRl?.pause();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cliJs, ...args], {
      stdio: "inherit",
      env: process.env,
    });
    const ignore = () => {};
    process.on("SIGINT", ignore);
    child.on("exit", (code) => {
      process.off("SIGINT", ignore);
      pipeRl?.resume();
      resolve(code ?? 1);
    });
    child.on("error", (err) => {
      process.off("SIGINT", ignore);
      fail(err.message);
      resolve(1);
    });
  });
}

/** Run a fixed command line through cmd.exe (needed for npm .cmd shims). Output captured. */
function sh(commandLine, timeoutMs = 20_000) {
  // Verbatim: Node would otherwise escape inner quotes as \" which cmd.exe misreads.
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"${commandLine}"`], {
    windowsVerbatimArguments: true,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env: process.env,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), timedOut: !!r.error };
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}
function loadLauncherState() {
  return readJson(launcherStatePath) ?? {};
}
function saveLauncherState(st) {
  fs.mkdirSync(path.dirname(launcherStatePath), { recursive: true });
  fs.writeFileSync(launcherStatePath, JSON.stringify(st, null, 2));
}

async function appModule(rel) {
  return import(pathToFileURL(path.join(appDir, "dist", rel)).href);
}

async function qqConfigured() {
  try {
    const { loadCredentials } = await appModule("security/secrets.js");
    return !!loadCredentials();
  } catch {
    return false;
  }
}

/** Agent command name from the user's config (default = backend id). Restrict to a safe charset. */
function agentCommand(kind) {
  const cfg = readJson(path.join(dataDir, "config.json"));
  const cmd = cfg?.agents?.[kind]?.command || kind;
  return /^[A-Za-z0-9_.:\\/ -]+$/.test(cmd) ? cmd : kind;
}

// ---------------------------------------------------------------- checks

function checkAgent(kind) {
  const cmd = agentCommand(kind);
  console.log(`\n${c.bold(`Checking ${BACKENDS[kind].label}`)}`);
  const where = sh(`where "${cmd}"`);
  if (where.code !== 0) {
    fail(`'${cmd}' was not found on PATH.`);
    info(`Install: ${BACKENDS[kind].install}`);
    info("Then open a NEW window and run this launcher again.");
    return { installed: false, loggedIn: false };
  }
  ok(`Found ${where.out.split(/\r?\n/)[0]}`);
  const ver = sh(`"${cmd}" --version`);
  if (ver.code === 0) ok(`Version: ${ver.out.split(/\r?\n/)[0]}`);
  else warn("Could not read version.");

  let loggedIn = false;
  if (kind === "claude") {
    const st = sh(`"${cmd}" auth status`);
    try {
      const j = JSON.parse(st.out.slice(st.out.indexOf("{")));
      loggedIn = j.loggedIn === true;
    } catch {
      loggedIn = false;
    }
    if (!loggedIn && process.env.ANTHROPIC_API_KEY) {
      loggedIn = true;
      ok("ANTHROPIC_API_KEY is set (value not shown).");
    }
    if (loggedIn) ok("Claude Code is logged in.");
    else {
      fail("Claude Code is not logged in.");
      info(`Run:  ${cmd}   (then follow the login prompt), or:  ${cmd} auth login`);
    }
  } else {
    const st = sh(`"${cmd}" login status`);
    loggedIn = st.code === 0 && /logged in/i.test(st.out) && !/not logged in/i.test(st.out);
    if (loggedIn) ok("Codex is logged in.");
    else {
      fail("Codex is not logged in.");
      info(`Run:  ${cmd} login`);
    }
  }
  return { installed: true, loggedIn };
}

function checkImages({ live }) {
  console.log(`\n${c.bold("Checking DDGS image search")}`);
  const py = process.env.QQBRIDGE_DDGS_PYTHON;
  if (!fs.existsSync(py)) {
    warn(`Python not found at ${py}. Image search will be unavailable (chat still works).`);
    return false;
  }
  const imp = spawnSync(py, ["-c", "import ddgs, sys; print(sys.version.split()[0])"], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  if (imp.status !== 0) {
    warn("The 'ddgs' package is missing from the bundled Python. Image search will be unavailable.");
    return false;
  }
  ok(`Bundled Python ${imp.stdout.trim()} with ddgs`);
  if (!live) return true;
  const r = spawnSync(py, [ddgsScript, "--query", "cat", "--max", "2"], {
    encoding: "utf8",
    timeout: 25_000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
  try {
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    if (j.ok && j.results?.length) {
      ok(`Live search returned ${j.results.length} result(s).`);
      return true;
    }
    warn(`Live search returned no results (${j.error ?? "empty"}). DuckDuckGo may be rate-limiting; try later.`);
  } catch {
    warn("Live search failed (network blocked or timed out). Chat still works.");
  }
  return false;
}

async function codexReady() {
  try {
    const { assertCodexRestrictedReadyForQq } = await appModule("security/codex-restricted.js");
    assertCodexRestrictedReadyForQq();
    return { ready: true };
  } catch (err) {
    return { ready: false, reason: err.message };
  }
}

async function verifyCodex() {
  console.log(`\n${c.bold("Restricted Codex verification")}`);
  info("This runs the Bridge's fail-closed probes: an isolated CODEX_HOME is created,");
  info("then three short real model calls confirm shell/file-write are blocked and");
  info("hosted web search works. It uses a small amount of your Codex quota.");
  if (!(await confirm("Run verification now?"))) return false;
  const code = await runCli(["verify-codex-restricted"]);
  if (code === 0) {
    ok("Restricted Codex verified (valid for 7 days or until Codex/policy changes).");
    return true;
  }
  fail("Verification failed. Codex will NOT be started for QQ (this is intentional).");
  info("Fix the reported issue (e.g. `codex login`, update Codex) and run it again.");
  return false;
}

// ---------------------------------------------------------------- flows

async function wizard() {
  console.log(`\n${c.bold("=== First-run setup ===")}\n`);
  console.log("What you need:");
  console.log("  1. A QQ account that can own a QQ Bot (QQ Open Platform: https://q.qq.com/).");
  console.log("  2. Mobile QQ, to scan a QR code that binds YOUR bot to this PC.");
  console.log("  3. Claude Code or Codex CLI installed and logged in with YOUR account.");
  console.log("\nNothing is shared with the author: credentials are stored encrypted in");
  console.log(`  ${dataDir}`);
  console.log("and replies are generated by your own AI CLI subscription.\n");

  // Step: QQ binding
  console.log(c.bold("Step 1/4 — QQ Bot binding"));
  if (await qqConfigured()) {
    ok("A QQ Bot is already bound.");
    if (await confirm("Re-bind a different bot?", false)) {
      if ((await runCli(["setup"])) !== 0) return fail("QQ binding failed."), false;
    }
  } else {
    info("A QR code will appear. Scan it with mobile QQ and confirm on your phone.");
    await ask("Press Enter to show the QR code...");
    if ((await runCli(["setup"])) !== 0 || !(await qqConfigured())) {
      fail("QQ binding did not complete. Run the launcher again to retry.");
      return false;
    }
  }

  // Step: backend
  console.log(`\n${c.bold("Step 2/4 — AI backend")}`);
  console.log(`  1) ${BACKENDS.claude.label}`);
  console.log(`  2) ${BACKENDS.codex.label}`);
  const pick = await ask("Choose 1 or 2 [1]: ", "1");
  const kind = pick === "2" ? "codex" : "claude";
  const agent = checkAgent(kind);
  if (!agent.installed || !agent.loggedIn) {
    warn("Finish installing / logging in, then run the launcher again. Your QQ binding is kept.");
    saveLauncherState({ ...loadLauncherState(), backend: kind });
    return false;
  }
  if ((await runCli(["set-transport", kind, BACKENDS[kind].transport])) !== 0) {
    fail("Could not save backend settings.");
    return false;
  }

  // Step: Codex restricted verification
  console.log(`\n${c.bold("Step 3/4 — Backend safety checks")}`);
  if (kind === "codex") {
    const st = await codexReady();
    if (st.ready) ok("Restricted Codex verification is current.");
    else if (!(await verifyCodex())) {
      saveLauncherState({ ...loadLauncherState(), backend: kind });
      return false;
    }
  } else {
    ok("Claude runs Chat-only (all tools disabled, no MCP, no web). Nothing to verify.");
  }

  // Step: images
  console.log(`\n${c.bold("Step 4/4 — Image search (optional)")}`);
  checkImages({ live: await confirm("Run a live DDGS image search test?") });

  saveLauncherState({ ...loadLauncherState(), backend: kind, setupCompletedAt: new Date().toISOString() });
  console.log(`\n${c.green(c.bold("Setup complete."))}`);
  console.log("Send a private message to your bot from the QQ account that scanned the QR code.");
  console.log("For groups, see 'Manage allowlist' in the menu.\n");
  if (await confirm("Start the Bridge now?")) await start();
  return true;
}

async function start() {
  const st = loadLauncherState();
  const kind = st.backend === "codex" ? "codex" : "claude";
  if (!(await qqConfigured())) {
    fail("No QQ Bot bound yet. Choose 'Run setup wizard' first.");
    return;
  }
  if (kind === "codex") {
    const r = await codexReady();
    if (!r.ready) {
      fail("Restricted Codex is not verified, so it will not be started.");
      info(r.reason ?? "");
      if (!(await verifyCodex())) return;
    }
  }
  console.log(`\n${c.bold(`Starting QQ CLI Bridge with ${BACKENDS[kind].label}`)}`);
  console.log(c.dim("Wait for the QQ gateway 'ready' log line, then message your bot."));
  console.log(c.dim("Press Ctrl+C to stop.\n"));
  const code = await runCli([kind, "--transport", BACKENDS[kind].transport, "--no-terminal"]);
  console.log(code === 0 ? "\nBridge stopped." : `\nBridge exited with code ${code}.`);
}

async function manageAllowlist() {
  await runCli(["allowlist", "list"]);
  console.log("\n  1) Allow a private-chat user (openid)");
  console.log("  2) Allow a group (group openid)");
  console.log("  0) Back");
  const a = await ask("Choose: ", "0");
  if (a !== "1" && a !== "2") return;
  const id = await ask(a === "1" ? "User openid: " : "Group openid: ");
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) {
    warn("That does not look like an openid. Nothing changed.");
    return;
  }
  await runCli(["allowlist", a === "1" ? "add" : "add-group", id]);
}

async function checkAll() {
  const st = loadLauncherState();
  console.log(`\n${c.bold("QQ Bot")}`);
  (await qqConfigured()) ? ok("Bound.") : fail("Not bound — run the setup wizard.");
  checkAgent("claude");
  checkAgent("codex");
  if (st.backend === "codex" || (await confirm("\nCheck restricted Codex status?", false))) {
    const r = await codexReady();
    r.ready ? ok("Restricted Codex verified.") : warn(`Restricted Codex not ready: ${r.reason}`);
  }
  checkImages({ live: await confirm("\nRun a live DDGS image search test?", false) });
}

async function menu() {
  for (;;) {
    const st = loadLauncherState();
    const kind = st.backend === "codex" ? "codex" : "claude";
    console.log(`\n${c.bold("=== QQ CLI Bridge ===")}  ${c.dim(`v${version} · backend: ${kind}`)}`);
    console.log("  1) Start Bridge");
    console.log("  2) Run setup wizard (QQ binding, backend, checks)");
    console.log("  3) Status");
    console.log("  4) Stop a running Bridge");
    console.log("  5) Check dependencies (Claude, Codex, image search)");
    console.log("  6) Verify restricted Codex");
    console.log("  7) Manage allowlist (users / groups)");
    console.log("  8) Open data folder");
    console.log("  0) Exit");
    const a = await ask("Choose: ", "");
    if (!a && noMoreInput()) return; // stdin closed: exit instead of looping
    if (a === "1") await start();
    else if (a === "2") await wizard();
    else if (a === "3") await runCli(["status"]);
    else if (a === "4") await runCli(["stop"]);
    else if (a === "5") await checkAll();
    else if (a === "6") await verifyCodex();
    else if (a === "7") await manageAllowlist();
    else if (a === "8") {
      fs.mkdirSync(dataDir, { recursive: true });
      spawn("explorer.exe", [dataDir], { detached: true, stdio: "ignore" }).unref();
    } else if (a === "0" || a.toLowerCase() === "q") return;
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const arg = process.argv[2];
  if (arg === "--check") {
    // Non-interactive health check (used by release verification and support).
    console.log(`QQ CLI Bridge v${version}`);
    console.log(`App:  ${appDir}`);
    console.log(`Data: ${dataDir}`);
    ok(`Node ${process.version} (bundled: ${process.execPath.startsWith(bundleDir)})`);
    (await qqConfigured()) ? ok("QQ Bot bound.") : warn("QQ Bot not bound.");
    checkAgent("claude");
    checkAgent("codex");
    checkImages({ live: process.argv.includes("--live") });
    return;
  }
  console.log(c.bold(`QQ CLI Bridge v${version} — Windows portable`));
  console.log(c.dim(`Data folder: ${dataDir}`));
  const st = loadLauncherState();
  if (!st.setupCompletedAt || !(await qqConfigured())) {
    await wizard();
  }
  await menu();
}

main().catch((err) => {
  console.error(c.red(`\nUnexpected error: ${err?.message ?? err}`));
  process.exitCode = 1;
});
