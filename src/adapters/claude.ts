import { BaseSessionAdapter } from "./base-session.js";
import type { AgentOptions } from "../types.js";
import type { ModelCatalog } from "../models/types.js";
import { injectModelArg } from "../models/parse-list.js";
import { runCommand } from "../util/process.js";
import { claudeChatOnlyArgs } from "../security/chat-only.js";
import { claudePersonaSystemArgs, loadPersona } from "../persona/load.js";

/**
 * Claude Code adapter (Chat-only).
 * Verified: `claude -p` with `--output-format json`, `--resume <session_id>`, `--model`.
 * Tools disabled via `--tools "" --restricted --strict-mcp-config`.
 * Persona is injected once at bootstrap via --system-prompt-file (not on every resume turn).
 */
export class ClaudeAdapter extends BaseSessionAdapter {
  readonly kind = "claude" as const;
  readonly displayName = "Claude Code";

  protected async bootstrapSession(options: AgentOptions): Promise<string> {
    const seed = "QQ CLI Bridge chat session start. Reply with OK.";
    const persona = loadPersona();
    const result = await runCommand(
      this.command,
      [
        ...this.extraArgs,
        "-p",
        seed,
        "--output-format",
        "json",
        ...claudeChatOnlyArgs(),
        ...claudePersonaSystemArgs(persona),
      ],
      { cwd: options.cwd, env: this.agentEnv(), timeoutMs: 5 * 60_000 },
    );
    const id = this.pickSessionId(result.stdout);
    if (!id) throw new Error("Claude did not return a session_id. Is `claude` authenticated?");
    return id;
  }

  protected buildResumeArgs(message: string, sessionId: string, modelId?: string) {
    // Do not re-attach --system-prompt-file on resume: Claude snapshot reuses the
    // bootstrap Persona; repeating it would waste tokens every turn.
    const args = [
      "-p",
      message,
      "--resume",
      sessionId,
      "--output-format",
      "json",
      ...claudeChatOnlyArgs(),
    ];
    return { args: injectModelArg(args, modelId, "--model") };
  }

  /** Test helper — chat-only argv for a resume turn. */
  buildResumeArgvForTests(message: string, sessionId: string, modelId?: string): string[] {
    return [...this.extraArgs, ...this.buildResumeArgs(message, sessionId, modelId).args];
  }

  /** Test helper — bootstrap argv including Persona system-prompt-file. */
  buildBootstrapArgvForTests(seed = "QQ CLI Bridge chat session start. Reply with OK."): string[] {
    const persona = loadPersona();
    return [
      ...this.extraArgs,
      "-p",
      seed,
      "--output-format",
      "json",
      ...claudeChatOnlyArgs(),
      ...claudePersonaSystemArgs(persona),
    ];
  }

  protected buildInteractiveArgs(sessionId?: string): string[] {
    if (!sessionId) return [];
    return ["--resume", sessionId];
  }

  override async listModels(): Promise<ModelCatalog> {
    return {
      backend: this.displayName,
      discovery: "documented-aliases",
      note:
        "Claude Code has no non-interactive account model catalog (interactive /model and `claude models` are not used headless). Aliases below are from `claude --help`. Full model names may also work via /model <id>.",
      models: [
        { id: "sonnet", displayName: "Sonnet (alias)", isDefault: true },
        { id: "opus", displayName: "Opus (alias)" },
        { id: "fable", displayName: "Fable (alias)" },
      ],
    };
  }

  private pickSessionId(stdout: string): string | undefined {
    try {
      const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
      if (typeof obj.session_id === "string") return obj.session_id;
      if (typeof obj.sessionId === "string") return obj.sessionId;
    } catch {
      // ndjson
    }
    for (const line of stdout.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const obj = JSON.parse(t) as Record<string, unknown>;
        if (typeof obj.session_id === "string") return obj.session_id;
      } catch {
        // ignore
      }
    }
    return undefined;
  }
}

export function createClaudeAdapter(command: string, extraArgs: string[]): ClaudeAdapter {
  return new ClaudeAdapter(command, extraArgs);
}
