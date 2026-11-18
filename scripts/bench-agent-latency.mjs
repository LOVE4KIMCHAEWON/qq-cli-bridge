/**
 * Small local latency comparison: oneshot `agent -p` vs persistent `agent acp`.
 * Uses a short prompt and the same model id. N is small by design (paid models).
 *
 * Usage:
 *   node scripts/bench-agent-latency.mjs
 *   node scripts/bench-agent-latency.mjs --model auto --n 2
 */
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const model = arg("--model", "auto");
const n = Number(arg("--n", "2"));
const prompt = arg("--prompt", "Reply with exactly: PONG");

function ms(t0) {
  return Date.now() - t0;
}

async function whereAgent() {
  if (process.platform !== "win32") return "agent";
  return await new Promise((resolve) => {
    const child = spawn("where.exe", ["agent"], { windowsHide: true });
    let buf = "";
    child.stdout.on("data", (b) => (buf += b.toString("utf8")));
    child.on("close", () => {
      const hit = buf
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.toLowerCase().endsWith("agent.cmd") || l.toLowerCase().endsWith("agent.exe"));
      resolve(hit || "agent");
    });
  });
}

function spawnAgent(agentPath, args) {
  if (process.platform === "win32" && agentPath.toLowerCase().endsWith(".cmd")) {
    const com = process.env.ComSpec || "cmd.exe";
    const cmdline = [`"${agentPath}"`, ...args.map((a) => `"${a.replace(/"/g, '""')}"`)].join(" ");
    return spawn(com, ["/d", "/s", "/c", cmdline], {
      cwd: root,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  return spawn(agentPath, args, {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function benchOneshot(agentPath) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    let firstStdout;
    let firstText;
    let finalAt;
    await new Promise((resolve, reject) => {
      const child = spawnAgent(agentPath, [
        "-p",
        prompt,
        "--model",
        model,
        "--output-format",
        "json",
        "-f",
      ]);
      let stdout = "";
      child.stdout.on("data", (b) => {
        if (firstStdout == null) firstStdout = ms(t0);
        stdout += b.toString("utf8");
        if (firstText == null && /PONG|pong|result/i.test(stdout)) firstText = ms(t0);
      });
      child.on("error", reject);
      child.on("close", () => {
        finalAt = ms(t0);
        if (firstText == null && stdout.trim()) firstText = finalAt;
        samples.push({
          firstStdoutMs: firstStdout,
          firstTextMs: firstText,
          finalMs: finalAt,
          exitMs: finalAt,
        });
        resolve();
      });
    });
  }
  return samples;
}

function send(child, pending, method, params) {
  const id = pending.nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.map.set(id, { resolve, reject });
  });
}

async function benchAcp(agentPath) {
  const tInit0 = Date.now();
  const child = spawnAgent(agentPath, ["acp"]);
  const pending = { nextId: 1, map: new Map() };
  const rl = readline.createInterface({ input: child.stdout });
  let assistant = "";
  let firstTextAt;

  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const w = pending.map.get(msg.id);
      if (!w) return;
      pending.map.delete(msg.id);
      msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") {
      const u = msg.params?.update;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.text) {
        if (firstTextAt == null) firstTextAt = Date.now();
        assistant += u.content.text;
      }
      return;
    }
    if (msg.method === "session/request_permission" && msg.id != null) {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { outcome: { outcome: "selected", optionId: "reject-once" } },
        }) + "\n",
      );
    }
    if (msg.method === "cursor/ask_question" && msg.id != null) {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { outcome: { outcome: "skipped", reason: "bench" } },
        }) + "\n",
      );
    }
    if (msg.method === "cursor/create_plan" && msg.id != null) {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { outcome: { outcome: "cancelled" } },
        }) + "\n",
      );
    }
  });

  await send(child, pending, "initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      _meta: { parameterizedModelPicker: true },
    },
    clientInfo: { name: "qqbridge-bench", version: "0.1.0" },
  });
  await send(child, pending, "authenticate", { methodId: "cursor_login" });
  const initMs = ms(tInit0);

  const { sessionId } = await send(child, pending, "session/new", {
    cwd: root,
    mcpServers: [],
  });

  try {
    await send(child, pending, "session/set_config_option", {
      sessionId,
      configId: "model",
      value: model,
    });
  } catch {
    // model option may differ; continue with default
  }

  const samples = [];
  for (let i = 0; i < n; i++) {
    assistant = "";
    firstTextAt = undefined;
    const t0 = Date.now();
    await send(child, pending, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    samples.push({
      firstTextMs: firstTextAt != null ? firstTextAt - t0 : undefined,
      finalMs: ms(t0),
      assistantPreview: assistant.slice(0, 40),
    });
  }

  try {
    child.stdin.end();
    child.kill();
  } catch {
    // ignore
  }

  return { initMs, samples };
}

function avg(nums) {
  const xs = nums.filter((x) => typeof x === "number");
  if (!xs.length) return undefined;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

const agentPath = await whereAgent();
console.log(`agent=${agentPath}`);
console.log(`model=${model} n=${n} prompt=${JSON.stringify(prompt)}`);
console.log("--- A) oneshot agent -p ---");
const oneshot = await benchOneshot(agentPath);
console.log(JSON.stringify(oneshot, null, 2));
console.log("avg firstTextMs", avg(oneshot.map((s) => s.firstTextMs)));
console.log("avg finalMs", avg(oneshot.map((s) => s.finalMs)));

console.log("--- B) persistent agent acp ---");
const acp = await benchAcp(agentPath);
console.log("cold initMs", acp.initMs, "(reported separately; not per-message)");
console.log(JSON.stringify(acp.samples, null, 2));
console.log("avg firstTextMs (warm prompts)", avg(acp.samples.map((s) => s.firstTextMs)));
console.log("avg finalMs (warm prompts)", avg(acp.samples.map((s) => s.finalMs)));
if (acp.samples.length > 1) {
  console.log(
    "2nd prompt finalMs",
    acp.samples[1].finalMs,
    "(exclude cold init from per-message latency)",
  );
}
