import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  AgentKind,
  AgentOptions,
  AgentOutput,
  AgentTurnHooks,
  AgentTurnOptions,
} from "../types.js";
import type { ModelCatalog, ModelSwitchResult } from "../models/types.js";
import { GeminiAcpClient } from "../gemini/acp-client.js";
import type { AcpPermissionMode } from "../acp/types.js";
import {
  clearPersistentSession,
  getPersistentSession,
  setPersistentSession,
} from "../persistent/session-store.js";
import { sanitizeForQq } from "../util/output-filter.js";
import { log } from "../util/logger.js";
import {
  buildTurnUsageRecord,
  recordTurnUsage,
  type UsageWarningThresholds,
} from "../telemetry/usage.js";
import { createGeminiAdapter } from "./gemini.js";
import {
  chatOnlyStatusLine,
  ensureChatRuntimeDir,
  isPrivilegedSessionMeta,
  sanitizeExtraArgs,
} from "../security/chat-only.js";

const TRANSPORT = "gemini-acp" as const;

export interface GeminiAcpAdapterOptions {
  command: string;
  extraArgs?: string[];
  permissionMode?: AcpPermissionMode;
  usageWarnings?: UsageWarningThresholds;
}

/**
 * Persistent Gemini CLI via `gemini --acp`.
 * Requires Gemini CLI installed and on PATH (or agents.gemini.command).
 * Oneshot GeminiAdapter remains the fallback.
 */
export class GeminiAcpAdapter implements AgentAdapter {
  readonly kind: AgentKind = "gemini";
  readonly displayName = "Gemini CLI (ACP)";
  readonly supportsSessionResume = true;

  private options?: AgentOptions;
  private command: string;
  private extraArgs: string[];
  private permissionMode: AcpPermissionMode;
  private usageWarnings?: UsageWarningThresholds;
  private listeners: Array<(output: AgentOutput) => void> = [];
  private stopped = false;
  private client?: GeminiAcpClient;
  private lastSessionId?: string;
  private sessionByConversation = new Map<string, string>();
  private inflightByConversation = new Set<string>();

  constructor(opts: GeminiAcpAdapterOptions) {
    this.command = opts.command;
    this.extraArgs = sanitizeExtraArgs(opts.extraArgs ?? []);
    this.permissionMode = "reject";
    void opts.permissionMode;
    this.usageWarnings = opts.usageWarnings;
  }

  onOutput(callback: (output: AgentOutput) => void): void {
    this.listeners.push(callback);
  }

  private emit(output: AgentOutput): void {
    if (output.kind === "status") {
      log.info(`[gemini-acp] ${output.text}`);
    }
    for (const cb of this.listeners) cb(output);
  }

  getSessionId(): string | undefined {
    return this.lastSessionId;
  }

  async start(options: AgentOptions): Promise<void> {
    this.stopped = false;
    const cwd = ensureChatRuntimeDir();
    this.options = { ...options, cwd };
    if (options.sessionId && !options.sessionId.startsWith("gemini-acp:")) {
      this.emit({
        kind: "status",
        text: "Ignoring oneshot session id for Gemini ACP (separate-session policy).",
      });
    }

    this.client = new GeminiAcpClient({
      command: this.command,
      extraArgs: this.extraArgs,
      cwd,
      permissionMode: "reject",
    });
    const { initMs } = await this.client.start();
    this.emit({
      kind: "status",
      text: `Gemini ACP ready (init ${initMs}ms). ${chatOnlyStatusLine(this.displayName)}`,
    });
  }

  async send(message: string, sessionId: string): Promise<void> {
    await this.sendAndCollect(message, sessionId);
  }

  async sendAndCollect(
    message: string,
    sessionId: string,
    hooks?: AgentTurnHooks,
    turn?: AgentTurnOptions,
  ): Promise<string> {
    if (this.stopped) throw new Error("Gemini ACP adapter stopped");
    const cwd = ensureChatRuntimeDir();
    const conversationId = turn?.conversationId || sessionId || "default";
    const turnId = randomUUID();

    if (this.inflightByConversation.has(conversationId)) {
      const msg =
        "A turn is already in progress for this conversation; duplicate prompt blocked.";
      this.emit({ kind: "error", text: msg, sessionId: this.lastSessionId });
      hooks?.onFinal?.();
      return msg;
    }
    this.inflightByConversation.add(conversationId);

    try {
      let client = this.client;
      if (!client?.isReady) {
        if (client?.lastTurnCompletionUnknown) {
          this.emit({
            kind: "status",
            text: "Recovering Gemini ACP after unknown-completion crash (not replaying prior prompt).",
          });
        }
        this.sessionByConversation.clear();
        client = new GeminiAcpClient({
          command: this.command,
          extraArgs: this.extraArgs,
          cwd,
          permissionMode: "reject",
        });
        this.client = client;
        await client.start();
        client.clearCrashLatch();
      }

      hooks?.onSpawn?.();
      const acpSessionId = await this.resolveSession(
        client,
        conversationId,
        cwd,
        turn?.modelId,
      );
      this.lastSessionId = `gemini-acp:${acpSessionId}`;

      try {
        if (turn?.modelId) {
          await client.setModel(acpSessionId, turn.modelId);
          setPersistentSession(TRANSPORT, conversationId, {
            sessionId: acpSessionId,
            cwd,
            modelId: turn.modelId,
          });
        }

        const { text, metrics, result } = await client.prompt(
          acpSessionId,
          message,
          {
            onPartialText: (chunk) => {
              this.emit({
                kind: "partial",
                text: chunk,
                sessionId: this.lastSessionId,
              });
            },
            onPermission: (summary) => {
              this.emit({
                kind: "approval_request",
                text: `Gemini ACP permission: ${summary} (mode=${this.permissionMode})`,
                sessionId: this.lastSessionId,
              });
            },
          },
        );

        const latencyMs =
          metrics.finalAt && metrics.promptSentAt
            ? metrics.finalAt - metrics.promptSentAt
            : undefined;

        recordTurnUsage(
          buildTurnUsageRecord({
            turnId,
            backend: this.displayName,
            transport: "acp",
            modelId: turn?.modelId,
            sessionId: acpSessionId,
            conversationId,
            latencyMs,
            usageRaw: result?.usage,
            usageUpdates: metrics.usageUpdates,
            thresholds: this.usageWarnings,
          }),
        );

        const clean = sanitizeForQq(text);
        if (!clean) {
          const err = "Gemini returned no assistant message for this turn.";
          this.emit({ kind: "error", text: err, sessionId: this.lastSessionId });
          hooks?.onFinal?.();
          return err;
        }
        this.emit({ kind: "final", text: clean, sessionId: this.lastSessionId });
        hooks?.onFinal?.();
        return clean;
      } catch (err) {
        const msg = sanitizeForQq((err as Error).message);
        this.emit({ kind: "error", text: msg, sessionId: this.lastSessionId });
        hooks?.onFinal?.();
        if (client.lastTurnCompletionUnknown) {
          await client.stop().catch(() => undefined);
          this.client = undefined;
          this.sessionByConversation.clear();
        }
        return msg;
      }
    } finally {
      this.inflightByConversation.delete(conversationId);
    }
  }

  private async resolveSession(
    client: GeminiAcpClient,
    conversationId: string,
    cwd: string,
    modelId?: string,
  ): Promise<string> {
    const mem = this.sessionByConversation.get(conversationId);
    if (mem) return mem;

    const stored = getPersistentSession(TRANSPORT, conversationId);
    if (
      stored &&
      isPrivilegedSessionMeta({
        cwd: stored.cwd,
        chatOnlyVersion: stored.chatOnlyVersion,
      })
    ) {
      clearPersistentSession(TRANSPORT, conversationId);
      this.emit({
        kind: "status",
        text: "Prior Gemini session was not chat-only; starting a fresh isolated chat session.",
      });
    }
    const safeStored = getPersistentSession(TRANSPORT, conversationId);
    if (safeStored?.sessionId) {
      try {
        const loaded = await client.sessionLoad(safeStored.sessionId, cwd);
        this.sessionByConversation.set(conversationId, loaded.sessionId);
        setPersistentSession(TRANSPORT, conversationId, {
          sessionId: loaded.sessionId,
          cwd,
          modelId: modelId ?? safeStored.modelId,
        });
        return loaded.sessionId;
      } catch (err) {
        log.warn("gemini-acp:session_load_failed", {
          message: (err as Error).message,
        });
        this.emit({
          kind: "status",
          text: "Could not load prior Gemini ACP session; creating a new one (history not silently migrated).",
        });
        clearPersistentSession(TRANSPORT, conversationId);
      }
    }

    const created = await client.sessionNew(cwd);
    this.sessionByConversation.set(conversationId, created.sessionId);
    setPersistentSession(TRANSPORT, conversationId, {
      sessionId: created.sessionId,
      cwd,
      modelId,
    });
    return created.sessionId;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.client?.stop();
    this.client = undefined;
    this.sessionByConversation.clear();
  }

  async attachTerminal(options: AgentOptions): Promise<number> {
    this.emit({
      kind: "status",
      text: "Gemini ACP mode: interactive terminal is not shared with the persistent process. Use oneshot for dual terminal+QQ, or --no-terminal.",
    });
    void options;
    return 0;
  }

  async listModels(): Promise<ModelCatalog> {
    // Reuse oneshot discovery helpers (no need to bootstrap a session).
    const oneshot = createGeminiAdapter(this.command, this.extraArgs);
    return oneshot.listModels();
  }

  async resolveModelSwitch(modelId: string | "default"): Promise<ModelSwitchResult> {
    if (modelId === "default") {
      return {
        ok: true,
        effectiveModelId: undefined,
        message: "Restored CLI default for subsequent Gemini ACP turns.",
      };
    }
    return {
      ok: true,
      effectiveModelId: modelId,
      message: `Will apply model ${modelId} via session/set_config_option when supported.`,
    };
  }
}

export function createGeminiAcpAdapter(
  command: string,
  extraArgs: string[],
  permissionMode: AcpPermissionMode = "reject",
  usageWarnings?: UsageWarningThresholds,
): GeminiAcpAdapter {
  return new GeminiAcpAdapter({
    command,
    extraArgs,
    permissionMode,
    usageWarnings,
  });
}
