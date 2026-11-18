/** One-shot probe: what usage fields does Cursor ACP actually emit? */
import readline from "node:readline";
import { resolveSpawnPlan, spawnWithPlan } from "../src/util/process.js";

const plan = await resolveSpawnPlan("agent", ["acp"]);
const child = spawnWithPlan(plan, {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});
if (!child.stdin || !child.stdout) throw new Error("no stdio");

let nextId = 1;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
const updates: unknown[] = [];

function send(method: string, params?: unknown): Promise<unknown> {
  const id = nextId++;
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error("timeout " + method));
    }, 90_000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(t);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(t);
        reject(e);
      },
    });
  });
}

readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let msg: {
    id?: number;
    result?: unknown;
    error?: { message?: string };
    method?: string;
    params?: unknown;
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
    updates.push((msg.params as { update?: unknown })?.update);
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
        result: { outcome: { outcome: "cancelled" } },
      }) + "\n",
    );
  }
});

await send("initialize", {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    _meta: { parameterizedModelPicker: true },
  },
  clientInfo: { name: "qqbridge-probe", version: "0.1.0" },
});
await send("authenticate", { methodId: "cursor_login" });
const created = (await send("session/new", {
  cwd: process.cwd(),
  mcpServers: [],
})) as { sessionId: string; configOptions?: unknown[] };
console.log(
  "configOption ids",
  JSON.stringify(
    (created.configOptions as Array<{ configId?: string; category?: string; currentValue?: unknown }> | undefined)?.map(
      (o) => ({ id: o.configId, cat: o.category, cur: o.currentValue }),
    ),
  ),
);
const result = await send("session/prompt", {
  sessionId: created.sessionId,
  prompt: [{ type: "text", text: "Reply with exactly: PONG" }],
});
console.log("prompt result", JSON.stringify(result).slice(0, 1000));
const kinds = [
  ...new Set(
    updates.map((u) => (u as { sessionUpdate?: string })?.sessionUpdate).filter(Boolean),
  ),
];
console.log("update kinds", kinds);
const usage = updates.filter(
  (u) =>
    (u as { sessionUpdate?: string })?.sessionUpdate === "usage_update" ||
    (u as { usage?: unknown })?.usage != null,
);
console.log("usage updates", JSON.stringify(usage).slice(0, 2000));
try {
  child.kill();
} catch {
  // ignore
}
process.exit(0);
