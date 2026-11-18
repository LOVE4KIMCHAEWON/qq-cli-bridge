/**
 * Small local latency comparison: oneshot `agent -p` vs persistent `agent acp`.
 *
 *   npx tsx scripts/bench-agent-latency.ts --model auto --n 2
 */
import readline from "node:readline";
import { resolveSpawnPlan, runCommand, spawnWithPlan } from "../src/util/process.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  return fallback;
}

const model = arg("--model", "auto");
const n = Number(arg("--n", "2"));
const prompt = arg("--prompt", "Reply with exactly: PONG");
const cwd = process.cwd();

function avg(nums: Array<number | undefined>): number | undefined {
  const xs = nums.filter((x): x is number => typeof x === "number");
  if (!xs.length) return undefined;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

async function benchOneshot() {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const result = await runCommand(
      "agent",
      ["-p", prompt, "--model", model, "--output-format", "json", "-f"],
      { cwd, timeoutMs: 180_000 },
    );
    const finalMs = Date.now() - t0;
    const hasText = /PONG|pong|"result"/i.test(result.stdout + result.stderr);
    samples.push({
      finalMs,
      exitCode: result.code,
      hasText,
      stdoutBytes: result.stdout.length,
    });
  }
  return samples;
}

async function benchAcp() {
  const plan = await resolveSpawnPlan("agent", ["acp"]);
  const child = spawnWithPlan(plan, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdin || !child.stdout) throw new Error("missing stdio");

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  const send = (method: string, params?: unknown) => {
    const id = nextId++;
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }, 180_000);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  };

  let firstTextAt: number | undefined;
  let assistant = "";

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: { update?: { sessionUpdate?: string; content?: { text?: string } } };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const w = pending.get(msg.id);
      if (!w) return;
      pending.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message ?? "error"));
      else w.resolve(msg.result);
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
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { outcome: { outcome: "selected", optionId: "reject-once" } },
        }) + "\n",
      );
    }
    if (
      (msg.method === "cursor/ask_question" || msg.method === "cursor/create_plan") &&
      msg.id != null
    ) {
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            outcome:
              msg.method === "cursor/ask_question"
                ? { outcome: "skipped", reason: "bench" }
                : { outcome: "cancelled" },
          },
        }) + "\n",
      );
    }
  });

  const tInit0 = Date.now();
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      _meta: { parameterizedModelPicker: true },
    },
    clientInfo: { name: "qqbridge-bench", version: "0.1.0" },
  });
  await send("authenticate", { methodId: "cursor_login" });
  const initMs = Date.now() - tInit0;

  const created = (await send("session/new", {
    cwd,
    mcpServers: [],
  })) as { sessionId: string; configOptions?: Array<{ configId: string; category?: string }> };
  const sessionId = created.sessionId;
  const modelOpt = created.configOptions?.find(
    (o) => o.category === "model" || o.configId === "model",
  );
  if (modelOpt) {
    try {
      await send("session/set_config_option", {
        sessionId,
        configId: modelOpt.configId,
        value: model,
      });
    } catch (err) {
      console.warn("model set skipped:", (err as Error).message);
    }
  }

  const samples = [];
  for (let i = 0; i < n; i++) {
    assistant = "";
    firstTextAt = undefined;
    const t0 = Date.now();
    await send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    samples.push({
      firstTextMs: firstTextAt != null ? firstTextAt - t0 : undefined,
      finalMs: Date.now() - t0,
      assistantPreview: assistant.slice(0, 60),
    });
  }

  try {
    child.kill();
  } catch {
    // ignore
  }
  rl.close();
  return { initMs, samples };
}

console.log(`model=${model} n=${n} prompt=${JSON.stringify(prompt)}`);
console.log("--- A) oneshot agent -p ---");
const oneshot = await benchOneshot();
console.log(JSON.stringify(oneshot, null, 2));
console.log("avg finalMs", avg(oneshot.map((s) => s.finalMs)));

console.log("--- B) persistent agent acp ---");
const acp = await benchAcp();
console.log("cold initMs", acp.initMs, "(separate from per-message latency)");
console.log(JSON.stringify(acp.samples, null, 2));
console.log("avg firstTextMs (warm)", avg(acp.samples.map((s) => s.firstTextMs)));
console.log("avg finalMs (warm)", avg(acp.samples.map((s) => s.finalMs)));
if (acp.samples.length > 1) {
  console.log("prompt[0] finalMs", acp.samples[0]!.finalMs, "(may include first-session warm-up)");
  console.log("prompt[1] finalMs", acp.samples[1]!.finalMs, "(warm)");
}
process.exit(0);
