import { NdjsonJsonRpcClient } from "../src/acp/jsonrpc-client.js";
import { ensureChatRuntimeDir } from "../src/security/chat-only.js";
import {
  assertCodexRestrictedReadyForQq,
  codexRestrictedChildEnv,
  codexRestrictedCliFlags,
  ensureCodexQqHome,
} from "../src/security/codex-restricted.js";
import { resolveSpawnPlan, spawnWithPlan } from "../src/util/process.js";

async function main(): Promise<void> {
  ensureCodexQqHome();
  const home = assertCodexRestrictedReadyForQq();
  const cwd = ensureChatRuntimeDir();
  const args = [...codexRestrictedCliFlags({ webSearch: "live" }), "app-server", "--stdio"];
  const plan = await resolveSpawnPlan("codex", args);
  const child = spawnWithPlan(plan, {
    cwd,
    env: codexRestrictedChildEnv(home.homeDir),
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdin || !child.stdout) throw new Error("no stdio");

  const rpc = new NdjsonJsonRpcClient(child.stdin, child.stdout, {
    defaultTimeoutMs: 120_000,
  });
  const serverReqs: Array<{ method: string; preview: string }> = [];

  rpc.on("notification", (method, params, raw) => {
    const msg = raw as { id?: string | number; method?: string; params?: unknown };
    if (msg?.id != null && typeof method === "string") {
      const preview = JSON.stringify(params).slice(0, 500);
      serverReqs.push({ method, preview });
      console.log("SERVER_REQ", method, preview);
      // Mirror Bridge: reject approvals/permissions (to observe impact).
      try {
        rpc.respondError(msg.id, { code: -32000, message: "rejected by probe" });
      } catch {
        // ignore
      }
      return;
    }
    if (/item|turn|permission|approval|web|error/i.test(method)) {
      console.log("NOTIF", method, JSON.stringify(params).slice(0, 400));
    }
  });

  if (child.stderr) {
    const rl = await import("node:readline");
    const rli = rl.createInterface({ input: child.stderr });
    rli.on("line", (line) => {
      if (/web_search|search|error|reject|permission/i.test(line)) {
        console.log("STDERR", line.slice(0, 300));
      }
    });
  }

  await rpc.request(
    "initialize",
    { clientInfo: { name: "probe", version: "0" }, capabilities: null },
    60_000,
  );
  const start = (await rpc.request("thread/start", {
    cwd,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "read-only",
    config: { web_search: "live" },
    developerInstructions:
      "Hosted web_search is allowed. Use web_search when asked for current facts.",
  })) as { thread?: { id?: string }; threadId?: string };
  const threadId = start.thread?.id ?? start.threadId;
  console.log("thread", threadId);
  await rpc.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Use web_search. Capital of France? One word." }],
  });
  await new Promise((r) => setTimeout(r, 25000));
  console.log("serverReqs_count", serverReqs.length);
  for (const s of serverReqs) console.log("REQ_SUMMARY", s.method, s.preview.slice(0, 200));
  child.kill();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
