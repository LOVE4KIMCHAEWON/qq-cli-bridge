import type {
  AgentAdapter,
  AgentKind,
  AgentOptions,
  AgentOutput,
  AgentTurnHooks,
  AgentTurnOptions,
} from "../types.js";
import type { ModelCatalog, ModelSwitchResult } from "../models/types.js";
import { runCommand, spawnInteractive } from "../util/process.js";
import { extractJsonFinalText, sanitizeForQq } from "../util/output-filter.js";
import { log } from "../util/logger.js";
import {
  assertSafeAgentCwd,
  ensureChatRuntimeDir,
  sanitizeExtraArgs,
  scrubAgentEnv,
  chatOnlyStatusLine,
} from "../security/chat-only.js";

export abstract class BaseSessionAdapter implements AgentAdapter {
  abstract readonly kind: AgentKind;
  abstract readonly displayName: string;
  readonly supportsSessionResume = true;

  protected options?: AgentOptions;
  protected sessionId?: string;
  protected command: string;
  protected extraArgs: string[];
  protected stopped = false;
  private listeners: Array<(output: AgentOutput) => void> = [];

  constructor(command: string, extraArgs: string[] = []) {
    this.command = command;
    this.extraArgs = sanitizeExtraArgs(extraArgs);
  }

  /** Scrubbed env for every agent child process. */
  protected agentEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
    return { ...scrubAgentEnv(), ...extra };
  }

  /** Chat-only runtime cwd (never project root). */
  protected agentCwd(preferred?: string): string {
    const runtime = ensureChatRuntimeDir();
    if (preferred) {
      try {
        return assertSafeAgentCwd(preferred);
      } catch {
        return runtime;
      }
    }
    return runtime;
  }

  onOutput(callback: (output: AgentOutput) => void): void {
    this.listeners.push(callback);
  }

  protected emit(output: AgentOutput): void {
    if (output.kind === "status") {
      log.info(`[${this.kind}] ${output.text}`, {
        listenerCount: this.listeners.length,
      });
    }
    for (const cb of this.listeners) cb(output);
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  async start(options: AgentOptions): Promise<void> {
    this.stopped = false;
    const cwd = this.agentCwd(options.cwd);
    this.options = { ...options, cwd };
    // Never resume a oneshot session id that may have been created with tools enabled.
    this.sessionId = undefined;
    this.sessionId = await this.bootstrapSession(this.options);
    this.emit({
      kind: "status",
      text: `${this.displayName} session ready — ${chatOnlyStatusLine(this.displayName)}`,
      sessionId: this.sessionId,
    });
  }

  async send(message: string, sessionId: string): Promise<void> {
    await this.sendAndCollect(message, sessionId);
  }

  /** Send a prompt and return the final sanitized text (also emits onOutput). */
  async sendAndCollect(
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
    const result = await runCommand(this.command, [...this.extraArgs, ...args], {
      cwd,
      env: this.agentEnv(env),
      timeoutMs: 10 * 60_000,
    });

    if ((result.code ?? 1) !== 0 && !result.stdout.trim()) {
      const err = sanitizeForQq(result.stderr || `Exit code ${result.code}`);
      this.emit({ kind: "error", text: err, sessionId: sid });
      hooks?.onFinal?.();
      return err;
    }

    const extracted = this.extractReplyText(result.stdout, result.stderr);
    const text = sanitizeForQq(extracted || "(empty agent response)");
    this.sessionId = sid;
    this.emit({ kind: "final", text, sessionId: sid, raw: result.stdout });
    hooks?.onFinal?.();
    return text;
  }

  /**
   * Extract QQ-visible reply text from CLI stdout/stderr.
   * Subclasses with structured event streams should override
   * (never fall back to dumping raw protocol JSON).
   */
  protected extractReplyText(stdout: string, stderr: string): string | undefined {
    return (
      extractJsonFinalText(stdout) ??
      (sanitizeForQq(stdout) || undefined) ??
      (sanitizeForQq(stderr) || undefined)
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async attachTerminal(options: AgentOptions): Promise<number> {
    // Chat-only: interactive terminal share is disabled — it would expose full agent tools.
    this.emit({
      kind: "status",
      text: "Chat-only policy: interactive terminal attach is disabled. QQ conversations stay headless.",
    });
    void options;
    return 0;
  }

  /** Create a session and return its id. */
  protected abstract bootstrapSession(options: AgentOptions): Promise<string>;

  /** Args for non-interactive resume with a prompt. */
  protected abstract buildResumeArgs(
    message: string,
    sessionId: string,
    modelId?: string,
  ): { args: string[]; env?: Record<string, string> };

  /** Args for interactive terminal attach. */
  protected abstract buildInteractiveArgs(sessionId?: string): string[];

  async listModels(): Promise<ModelCatalog> {
    return {
      backend: this.displayName,
      discovery: "unavailable",
      note: "This adapter does not expose programmatic model discovery.",
      models: [],
    };
  }

  async resolveModelSwitch(modelId: string | "default"): Promise<ModelSwitchResult> {
    if (modelId === "default" || modelId.toLowerCase() === "default") {
      return {
        ok: true,
        effectiveModelId: undefined,
        message: `Restored ${this.displayName} default model for this conversation.`,
      };
    }
    const catalog = await this.listModels();
    if (catalog.discovery === "dynamic") {
      const hit = catalog.models.find(
        (m) => m.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (!hit) {
        return {
          ok: false,
          message: `Model "${modelId}" is not available for ${this.displayName}. Use /model to list available models.`,
        };
      }
      return {
        ok: true,
        effectiveModelId: hit.id,
        message: `Switched to ${hit.id}. Subsequent turns in this conversation will use --model ${hit.id}.`,
      };
    }
    if (catalog.discovery === "documented-aliases") {
      const hit = catalog.models.find(
        (m) => m.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (hit) {
        return {
          ok: true,
          effectiveModelId: hit.id,
          message: `Switched to ${hit.id}. Subsequent turns will pass --model ${hit.id}.`,
        };
      }
      // Full names may still be valid; accept with explicit caveat.
      return {
        ok: true,
        effectiveModelId: modelId,
        message: `Accepted "${modelId}" without dynamic validation (${catalog.note ?? "discovery limited"}). Subsequent turns will pass --model ${modelId}.`,
      };
    }
    // unavailable — still allow explicit ids; CLI will error on the next turn if invalid
    return {
      ok: true,
      effectiveModelId: modelId,
      message: `Set model to "${modelId}" without a live catalog. ${catalog.note ?? ""}`.trim(),
    };
  }
}
