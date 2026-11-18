import { spawn } from "node:child_process";

// Developer probe (requires an authenticated Codex CLI). Not used by the bridge.
// Override with CODEX_BIN=<path to codex(.cmd)>; runs in the current directory.
const CODEX = process.env.CODEX_BIN || "codex";
const CWD = process.cwd();

const codex = spawn(CODEX, ["app-server", "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: true,
  cwd: CWD,
});

let nextId = 1;
const pending = new Map();
let buffer = "";

function onLine(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log("PARSE_ERR", line.slice(0, 120));
    return;
  }
  if (msg.id != null && ("result" in msg || "error" in msg)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p(msg);
    }
    return;
  }
  if (typeof msg.method === "string") {
    const preview = JSON.stringify(msg.params ?? {}).slice(0, 240);
    console.log("NOTIFY", msg.method, preview);
  }
}

codex.stdout.setEncoding("utf8");
codex.stdout.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).replace(/\r$/, "");
    buffer = buffer.slice(idx + 1);
    onLine(line);
  }
});
codex.stderr.on("data", (d) => process.stderr.write(d));

function request(method, params, timeoutMs = 120_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout ${method}`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg);
    });
    codex.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) +
        "\n",
    );
  });
}

async function main() {
  const init = await request("initialize", {
    clientInfo: { name: "qq-cli-bridge-probe", version: "0.0.1" },
  });
  console.log("RESP initialize", JSON.stringify(init.result));

  const thread = await request("thread/start", {
    cwd: CWD,
    sandbox: "workspace-write",
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
  });
  console.log("RESP thread/start keys", Object.keys(thread.result ?? {}));
  const threadId =
    thread.result?.thread?.id ?? thread.result?.threadId ?? thread.result?.id;
  console.log("threadId", threadId);
  if (!threadId) {
    codex.kill();
    return;
  }

  const turn = await request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply with exactly: APP_SERVER_OK" }],
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
  });
  console.log("RESP turn/start", JSON.stringify(turn.result).slice(0, 500));

  await new Promise((r) => setTimeout(r, 60_000));
  codex.kill();
}

main().catch((err) => {
  console.error("FAIL", err);
  codex.kill();
  process.exit(1);
});