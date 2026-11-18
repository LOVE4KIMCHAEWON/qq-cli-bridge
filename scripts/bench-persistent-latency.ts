/**
 * Short latency probe for persistent vs oneshot backends.
 * Usage: npx tsx scripts/bench-persistent-latency.ts --backend claude|codex --n 2
 *
 * Asks before large batches — keep --n small (default 2).
 */
import { ClaudeStreamClient } from "../src/claude/stream-client.js";
import { CodexAppServerClient } from "../src/codex/app-server-client.js";
import { runCommand } from "../src/util/process.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1] ?? fallback;
  return fallback;
}

const backend = arg("--backend", "claude")!;
const n = Math.min(Number(arg("--n", "2") || 2), 3);
const prompt = "Reply with exactly: PONG";
const cwd = process.cwd();

async function benchClaude() {
  console.log("=== Claude oneshot (cold each turn) ===");
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const r = await runCommand(
      "claude",
      ["-p", prompt, "--output-format", "json"],
      { cwd, timeoutMs: 180_000 },
    );
    console.log(`oneshot[${i}] finalMs=${Date.now() - t0} code=${r.code}`);
  }

  console.log("=== Claude stream (cold then warm) ===");
  const client = new ClaudeStreamClient({ command: "claude", cwd });
  const tInit = Date.now();
  const { initMs } = await client.start();
  console.log(`stream initMs=${initMs} (wall ${Date.now() - tInit})`);
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const r = await client.prompt(prompt);
    const finalMs = Date.now() - t0;
    const first =
      r.metrics.firstTextAt && r.metrics.promptSentAt
        ? r.metrics.firstTextAt - r.metrics.promptSentAt
        : undefined;
    console.log(
      `stream[${i}] firstTextMs=${first ?? "n/a"} finalMs=${finalMs} text=${JSON.stringify(r.text.slice(0, 40))} pid=${client.pid}`,
    );
  }
  await client.stop();
}

async function benchCodex() {
  console.log("=== Codex exec oneshot ===");
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const r = await runCommand(
      "codex",
      ["exec", "--skip-git-repo-check", "--json", prompt],
      { cwd, timeoutMs: 180_000 },
    );
    console.log(`oneshot[${i}] finalMs=${Date.now() - t0} code=${r.code} out=${r.stdout.length}`);
  }

  console.log("=== Codex app-server (cold then warm) ===");
  const client = new CodexAppServerClient({
    command: "codex",
    cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const tInit = Date.now();
  const { initMs } = await client.start();
  console.log(`app-server initMs=${initMs} (wall ${Date.now() - tInit})`);
  const { threadId } = await client.threadStart({ cwd });
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const r = await client.turnStart(threadId, prompt);
    const finalMs = Date.now() - t0;
    const first =
      r.metrics.firstTextAt && r.metrics.promptSentAt
        ? r.metrics.firstTextAt - r.metrics.promptSentAt
        : undefined;
    console.log(
      `app-server[${i}] firstTextMs=${first ?? "n/a"} finalMs=${finalMs} text=${JSON.stringify(r.text.slice(0, 40))} tokens_in=${r.usage?.inputTokens ?? "n/a"}`,
    );
  }
  await client.stop();
}

async function main() {
  if (n > 3) {
    console.error("Refusing large batch; ask before expensive runs. Max --n 3.");
    process.exit(1);
  }
  if (backend === "claude") await benchClaude();
  else if (backend === "codex") await benchCodex();
  else {
    console.error("Unknown --backend (claude|codex)");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
