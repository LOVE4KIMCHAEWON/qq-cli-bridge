import { randomUUID } from "node:crypto";
import { BaseSessionAdapter } from "./base-session.js";
import type {
  AgentOptions,
  AgentTurnHooks,
  AgentTurnOptions,
} from "../types.js";
import type { ModelCatalog } from "../models/types.js";
import { parseCodexModelJson } from "../models/parse-list.js";
import {
  looksLikeCodexJsonl,
  parseCodexExecJsonl,
} from "../util/codex-jsonl.js";
import { runCommand } from "../util/process.js";
import { sanitizeForQq } from "../util/output-filter.js";
import { log } from "../util/logger.js";
import {
  buildTurnUsageRecord,
  recordTurnUsage,
} from "../telemetry/usage.js";
import { codexExecChatOnlyArgs } from "../security/chat-only.js";

/**
 * OpenAI Codex CLI adapter (Chat-only).
 * Verified (Codex CLI v0.169): `codex exec` / `codex exec resume --last|<id>`
 * with `--json`, `--model`/`-m`, `--skip-git-repo-check`.
 * Enforces `-s read-only` and untrusted approval policy.
 */
export class CodexAdapter extends BaseSessionAdapter {
  readonly kind = "codex" as const;
  readonly displayName = "Codex CLI";

  private readonly skipGitRepoCheck: boolean;

  constructor(
    command: string,
    extraArgs: string[] = [],
    options: { skipGitRepoCheck?: boolean } = {},
  ) {
    super(command, extraArgs);
    this.skipGitRepoCheck = options.skipGitRepoCheck ?? false;
  }

  private execOptions(modelId?: string): string[] {
    const flags: string[] = [...codexExecChatOnlyArgs()];
    if (modelId) flags.push("--model", modelId);
    if (this.skipGitRepoCheck) flags.push("--skip-git-repo-check");
    return flags;
  }

  protected async bootstrapSession(options: AgentOptions): Promise<string> {
    const seed = "QQ CLI Bridge chat session start. Reply with OK.";
    const result = await runCommand(
      this.command,
      [...this.extraArgs, "exec", ...this.execOptions(), "--json", seed],
      { cwd: this.agentCwd(options.cwd), env: this.agentEnv(), timeoutMs: 5 * 60_000 },
    );
    const parsed = parseCodexExecJsonl(result.stdout);
    return (
      parsed.threadId ??
      this.pickSessionId(result.stdout + "\n" + result.stderr) ??
      "last"
    );
  }

  protected buildResumeArgs(
    message: string,
    sessionId: string,
    modelId?: string,
  ): { args: string[]; env?: Record<string, string> } {
    const execOpts = this.execOptions(modelId);
    if (sessionId === "last" || sessionId === "latest") {
      return {
        args: ["exec", ...execOpts, "resume", "--last", "--json", message],
      };
    }
    return {
      args: ["exec", ...execOpts, "resume", sessionId, "--json", message],
    };
  }

  protected buildInteractiveArgs(sessionId?: string): string[] {
    if (!sessionId || sessionId === "last" || sessionId === "latest") {
      return ["resume", "--last", "--include-non-interactive"];
    }
    return ["resume", sessionId];
  }

  override async sendAndCollect(
    message: string,
    sessionId: string,
    hooks?: AgentTurnHooks,
    turn?: AgentTurnOptions,
  ): Promise<string> {
    if (this.stopped) throw new Error("Adapter stopped");
    const cwd = this.agentCwd(this.options?.cwd);
    const sid = sessionId || this.sessionId;
    if (!sid) throw new Error("No session id");

    this.emit({ kind: "status", text: "Sending to agent…", sessionId: sid });
    const { args, env } = this.buildResumeArgs(message, sid, turn?.modelId);
    hooks?.onSpawn?.();
    const t0 = Date.now();
    const result = await runCommand(this.command, [...this.extraArgs, ...args], {
      cwd,
      env: this.agentEnv(env),
      timeoutMs: 10 * 60_000,
    });

    if ((result.code ?? 1) !== 0 && !result.stdout.trim()) {
      const err =
        sanitizeForQq(result.stderr || `Exit code ${result.code}`) ||
        "Codex failed with no output.";
      log.warn("codex:turn_failed", {
        code: result.code,
        stderrPreview: (result.stderr || "").slice(0, 200),
      });
      this.emit({ kind: "error", text: err, sessionId: sid });
      hooks?.onFinal?.();
      return err;
    }

    const parsed = parseCodexExecJsonl(result.stdout);
    if (parsed.threadId) this.sessionId = parsed.threadId;
    else this.sessionId = sid;

    this.recordCodexUsage(parsed, turn, Date.now() - t0);

    let text = parsed.text;
    if (!text) {
      if (parsed.hadJsonlEvents) {
        log.warn("codex:no_agent_message", {
          parseErrors: parsed.parseErrors,
          assistantMessageCount: parsed.assistantMessageCount,
        });
        text = "Codex returned no assistant message for this turn.";
      } else if (!looksLikeCodexJsonl(result.stdout)) {
        text =
          sanitizeForQq(result.stderr) ||
          "Codex returned no assistant message for this turn.";
      } else {
        text = "Codex returned no assistant message for this turn.";
      }
    }

    const clean = sanitizeForQq(text);
    if (!clean || looksLikeCodexJsonl(clean) || /^\s*\{"type":"/.test(clean)) {
      log.error("codex:refusing_raw_jsonl_reply", {
        preview: (clean || "").slice(0, 80),
      });
      const safe = "Codex returned no readable assistant message for this turn.";
      this.emit({ kind: "error", text: safe, sessionId: this.sessionId });
      hooks?.onFinal?.();
      return safe;
    }

    this.emit({ kind: "final", text: clean, sessionId: this.sessionId });
    hooks?.onFinal?.();
    return clean;
  }

  protected override extractReplyText(stdout: string, stderr: string): string | undefined {
    const parsed = parseCodexExecJsonl(stdout);
    if (parsed.text) return parsed.text;
    if (parsed.hadJsonlEvents || looksLikeCodexJsonl(stdout)) return undefined;
    return sanitizeForQq(stderr) || undefined;
  }

  private recordCodexUsage(
    parsed: ReturnType<typeof parseCodexExecJsonl>,
    turn: AgentTurnOptions | undefined,
    latencyMs: number,
  ): void {
    const u = parsed.usage;
    if (!u) {
      recordTurnUsage(
        buildTurnUsageRecord({
          turnId: randomUUID(),
          backend: this.displayName,
          transport: "unknown",
          modelId: turn?.modelId,
          sessionId: this.sessionId,
          conversationId: turn?.conversationId,
          latencyMs,
        }),
      );
      return;
    }

    // cached_input_tokens is not added on top of input_tokens for totals.
    const input = u.inputTokens;
    const output = u.outputTokens;
    const thought = u.reasoningOutputTokens;
    const total =
      input != null || output != null
        ? (input ?? 0) + (output ?? 0) + (thought ?? 0)
        : undefined;

    recordTurnUsage(
      buildTurnUsageRecord({
        turnId: randomUUID(),
        backend: this.displayName,
        transport: "unknown",
        modelId: turn?.modelId,
        sessionId: this.sessionId,
        conversationId: turn?.conversationId,
        latencyMs,
        usageRaw: {
          inputTokens: input,
          outputTokens: output,
          cachedReadTokens: u.cachedInputTokens,
          cachedWriteTokens: u.cacheWriteInputTokens,
          thoughtTokens: thought,
          totalTokens: total,
        },
      }),
    );
  }

  buildResumeArgvForTests(message: string, sessionId: string, modelId?: string): string[] {
    return [...this.extraArgs, ...this.buildResumeArgs(message, sessionId, modelId).args];
  }

  buildBootstrapArgvForTests(seed: string, modelId?: string): string[] {
    return [...this.extraArgs, "exec", ...this.execOptions(modelId), "--json", seed];
  }

  override async listModels(): Promise<ModelCatalog> {
    const cwd = this.options?.cwd ?? process.cwd();
    try {
      const result = await runCommand(
        this.command,
        [...this.extraArgs, "debug", "models"],
        { cwd, timeoutMs: 60_000 },
      );
      const text = result.stdout || result.stderr;
      const models = parseCodexModelJson(text);
      if (models.length > 0) {
        return {
          backend: this.displayName,
          discovery: "dynamic",
          models,
          note: "Listed via `codex debug models` (account/catalog scoped).",
        };
      }
      return {
        backend: this.displayName,
        discovery: "unavailable",
        models: [],
        note: `codex debug models returned no parseable models: ${(text || `exit ${result.code}`).trim().slice(0, 240)}`,
      };
    } catch (err) {
      const msg = (err as Error).message;
      return {
        backend: this.displayName,
        discovery: "unavailable",
        models: [],
        note:
          /ENOENT|not found|Could not find/i.test(msg)
            ? "Codex CLI is not installed or not on PATH. Install it to enable dynamic model discovery."
            : `Codex model discovery failed: ${msg.slice(0, 240)}`,
      };
    }
  }

  private pickSessionId(text: string): string | undefined {
    const fromJsonl = parseCodexExecJsonl(text).threadId;
    if (fromJsonl) return fromJsonl;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const obj = JSON.parse(t) as Record<string, unknown>;
        for (const key of ["thread_id", "session_id", "sessionId", "id"]) {
          if (typeof obj[key] === "string") return obj[key] as string;
        }
      } catch {
        // ignore
      }
    }
    return text.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    )?.[0];
  }
}

export function createCodexAdapter(
  command: string,
  extraArgs: string[],
  options: { skipGitRepoCheck?: boolean } = {},
): CodexAdapter {
  return new CodexAdapter(command, extraArgs, options);
}
