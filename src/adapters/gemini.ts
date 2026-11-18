import { BaseSessionAdapter } from "./base-session.js";
import type { AgentOptions } from "../types.js";
import type { ModelCatalog } from "../models/types.js";
import { injectModelArg, parseGeminiModelJson } from "../models/parse-list.js";
import { runCommand } from "../util/process.js";
import { extractJsonFinalText } from "../util/output-filter.js";
import { geminiOneshotChatOnlyArgs } from "../security/chat-only.js";

/**
 * Gemini CLI adapter (Chat-only).
 * Uses `--approval-mode plan` (read-only). Never `--yolo`.
 */
export class GeminiAdapter extends BaseSessionAdapter {
  readonly kind = "gemini" as const;
  readonly displayName = "Gemini CLI";

  protected async bootstrapSession(options: AgentOptions): Promise<string> {
    const seed = "QQ CLI Bridge chat session start. Reply with OK.";
    const cwd = this.agentCwd(options.cwd);
    const result = await runCommand(
      this.command,
      [
        ...this.extraArgs,
        "-p",
        seed,
        "--output-format",
        "json",
        ...geminiOneshotChatOnlyArgs(),
      ],
      { cwd, env: this.agentEnv(), timeoutMs: 5 * 60_000 },
    );

    const sessionFromJson = this.pickSessionId(result.stdout);
    if (sessionFromJson) return sessionFromJson;

    const listed = await runCommand(this.command, [...this.extraArgs, "--list-sessions"], {
      cwd,
      env: this.agentEnv(),
      timeoutMs: 60_000,
    });
    const fromList = this.parseLatestSession(listed.stdout + "\n" + listed.stderr);
    if (fromList) return fromList;

    // Fallback tag — resume "latest" still works for send().
    return "latest";
  }

  protected buildResumeArgs(message: string, sessionId: string, modelId?: string) {
    const args = [
      "-p",
      message,
      "--resume",
      sessionId,
      "--output-format",
      "json",
      ...geminiOneshotChatOnlyArgs(),
    ];
    return { args: injectModelArg(args, modelId, "--model") };
  }

  buildResumeArgvForTests(message: string, sessionId: string, modelId?: string): string[] {
    return [...this.extraArgs, ...this.buildResumeArgs(message, sessionId, modelId).args];
  }

  protected buildInteractiveArgs(sessionId?: string): string[] {
    if (!sessionId || sessionId === "latest") return ["--resume", "latest"];
    return ["--resume", sessionId];
  }

  override async listModels(): Promise<ModelCatalog> {
    const cwd = this.options?.cwd ?? process.cwd();
    const attempts: string[][] = [
      ["models", "list", "-o", "json"],
      ["models", "-o", "json"],
      ["--list-models", "--output-format", "json"],
      ["--list-models", "-o", "json"],
    ];
    let lastErr = "";
    for (const argv of attempts) {
      try {
        const result = await runCommand(this.command, [...this.extraArgs, ...argv], {
          cwd,
          timeoutMs: 60_000,
        });
        const text = result.stdout || result.stderr;
        const models = parseGeminiModelJson(text);
        if (models.length > 0) {
          return {
            backend: this.displayName,
            discovery: "dynamic",
            models,
            note: "Listed via Gemini CLI models / --list-models JSON.",
          };
        }
        lastErr = (text || `exit ${result.code}`).trim();
      } catch (err) {
        lastErr = (err as Error).message;
      }
    }
    return {
      backend: this.displayName,
      discovery: "unavailable",
      models: [],
      note:
        lastErr.includes("ENOENT") || /not found|Could not find/i.test(lastErr)
          ? "Gemini CLI is not installed or not on PATH. Install it to enable dynamic model discovery."
          : `Gemini model discovery failed: ${lastErr.slice(0, 240)}`,
    };
  }

  private pickSessionId(stdout: string): string | undefined {
    try {
      const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
      for (const key of ["session_id", "sessionId", "id"]) {
        if (typeof obj[key] === "string") return obj[key] as string;
      }
    } catch {
      // ndjson
    }
    for (const line of stdout.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const obj = JSON.parse(t) as Record<string, unknown>;
        for (const key of ["session_id", "sessionId", "id"]) {
          if (typeof obj[key] === "string") return obj[key] as string;
        }
      } catch {
        // ignore
      }
    }
    // Sometimes only the final text is present; still useful for smoke tests
    void extractJsonFinalText(stdout);
    return undefined;
  }

  private parseLatestSession(text: string): string | undefined {
    const uuid =
      text.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
      )?.[0] ?? undefined;
    return uuid;
  }
}

export function createGeminiAdapter(command: string, extraArgs: string[]): GeminiAdapter {
  return new GeminiAdapter(command, extraArgs);
}
