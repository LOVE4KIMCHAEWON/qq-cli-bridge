import { BaseSessionAdapter } from "./base-session.js";
import type { AgentOptions } from "../types.js";
import type { ModelCatalog, ModelSwitchResult } from "../models/types.js";
import { injectModelArg, parseAgentModelList } from "../models/parse-list.js";
import { runCommand } from "../util/process.js";
import { cursorOneshotChatOnlyArgs } from "../security/chat-only.js";

/**
 * Cursor Agent CLI adapter (`agent`) — Chat-only.
 * Never passes `-f`/`--force`/`--yolo`. Uses plan mode + sandbox enabled.
 */
export class CursorAgentAdapter extends BaseSessionAdapter {
  readonly kind = "agent" as const;
  readonly displayName = "Cursor Agent";

  protected async bootstrapSession(options: AgentOptions): Promise<string> {
    // Token optimization: do NOT spend a paid model turn on a seed prompt.
    // Lazy session — first QQ message uses --continue / creates context then.
    void options;
    return "continue";
  }

  protected buildResumeArgs(message: string, sessionId: string, modelId?: string) {
    let args: string[];
    if (sessionId === "continue" || sessionId === "latest") {
      args = [
        "-p",
        message,
        "--continue",
        "--output-format",
        "json",
        ...cursorOneshotChatOnlyArgs(),
      ];
    } else {
      args = [
        "-p",
        message,
        "--resume",
        sessionId,
        "--output-format",
        "json",
        ...cursorOneshotChatOnlyArgs(),
      ];
    }
    return { args: injectModelArg(args, modelId, "--model") };
  }

  /** Test helper */
  buildResumeArgvForTests(message: string, sessionId: string, modelId?: string): string[] {
    return [...this.extraArgs, ...this.buildResumeArgs(message, sessionId, modelId).args];
  }

  protected buildInteractiveArgs(sessionId?: string): string[] {
    if (!sessionId || sessionId === "continue" || sessionId === "latest") {
      return ["--continue"];
    }
    return ["--resume", sessionId];
  }

  override async listModels(): Promise<ModelCatalog> {
    const cwd = this.options?.cwd ?? process.cwd();
    const attempts = [["--list-models"], ["models"]];
    let lastErr = "";
    for (const argv of attempts) {
      const result = await runCommand(this.command, [...this.extraArgs, ...argv], {
        cwd,
        timeoutMs: 60_000,
      });
      const text = `${result.stdout}\n${result.stderr}`;
      const models = parseAgentModelList(text);
      if (models.length > 0) {
        return {
          backend: this.displayName,
          discovery: "dynamic",
          models,
          note: "Listed via Cursor Agent --list-models (account-scoped).",
        };
      }
      lastErr = text.trim() || `exit ${result.code}`;
    }
    return {
      backend: this.displayName,
      discovery: "unavailable",
      models: [],
      note: `Could not list models from Cursor Agent: ${lastErr.slice(0, 200)}`,
    };
  }

  override async resolveModelSwitch(
    modelId: string | "default",
  ): Promise<ModelSwitchResult> {
    if (modelId === "default" || modelId.toLowerCase() === "default") {
      return {
        ok: true,
        effectiveModelId: undefined,
        message: "Restored Cursor Agent default model for this conversation.",
      };
    }
    const catalog = await this.listModels();
    if (catalog.discovery !== "dynamic" || catalog.models.length === 0) {
      return {
        ok: false,
        message: `Cannot validate model "${modelId}": ${catalog.note ?? "model list unavailable"}.`,
      };
    }
    const hit = catalog.models.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
    if (!hit) {
      return {
        ok: false,
        message: `Model "${modelId}" is not available for Cursor Agent. Use /model to list available models.`,
      };
    }
    return {
      ok: true,
      effectiveModelId: hit.id,
      message: `Switched to ${hit.id}${hit.displayName && hit.displayName !== hit.id ? ` (${hit.displayName})` : ""}. Subsequent turns will use --model ${hit.id}.`,
    };
  }

  private pickSessionId(text: string): string | undefined {
    try {
      const obj = JSON.parse(text.trim()) as Record<string, unknown>;
      for (const key of ["session_id", "sessionId", "chatId", "id"]) {
        if (typeof obj[key] === "string") return obj[key] as string;
      }
    } catch {
      // continue
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const obj = JSON.parse(t) as Record<string, unknown>;
        for (const key of ["session_id", "sessionId", "chatId", "id"]) {
          if (typeof obj[key] === "string") return obj[key] as string;
        }
      } catch {
        // ignore
      }
    }
    return undefined;
  }
}

export function createAgentAdapter(command: string, extraArgs: string[]): CursorAgentAdapter {
  return new CursorAgentAdapter(command, extraArgs);
}
