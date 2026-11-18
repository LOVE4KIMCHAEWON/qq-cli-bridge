import type {
  AgentAdapter,
  AgentKind,
  AgentOptions,
  AgentOutput,
  AgentTurnHooks,
  AgentTurnOptions,
} from "../types.js";
import type { ModelCatalog, ModelSwitchResult } from "../models/types.js";
import { CursorAcpClient } from "../acp/client.js";
import type { AcpPermissionMode, AcpSessionMode } from "../acp/types.js";
import {
  clearAcpSession,
  getAcpSession,
  setAcpSession,
} from "../acp/session-store.js";
import { parseAgentModelList } from "../models/parse-list.js";
import { runCommand } from "../util/process.js";
import { sanitizeForQq } from "../util/output-filter.js";
import { log } from "../util/logger.js";
import {
  buildTurnUsageRecord,
  recordTurnUsage,
  type UsageWarningThresholds,
} from "../telemetry/usage.js";
import { randomUUID } from "node:crypto";
import {
  chatOnlyStatusLine,
  ensureChatRuntimeDir,
  isPrivilegedSessionMeta,
  sanitizeExtraArgs,
} from "../security/chat-only.js";

export interface CursorAgentAcpOptions {
  command: string;
  extraArgs?: string[];
  permissionMode?: AcpPermissionMode;
  sessionMode?: AcpSessionMode;
  usageWarnings?: UsageWarningThresholds;
}

/**
 * Persistent Cursor Agent via ACP (`agent acp`).
 *
 * Session policy:
 * - ACP session ids are stored separately from oneshot `--resume` ids.
 * - Oneshoot session ids are never passed to session/load.
 * - Each QQ conversationId maps to its own ACP session.
 */
export class CursorAgentAcpAdapter implements AgentAdapter {
  readonly kind: AgentKind = "agent";
  readonly displayName = "Cursor Agent (ACP)";
  readonly supportsSessionResume = true;

  private options?: AgentOptions;
  private client?: CursorAcpClient;
  private lastSessionId?: string;
  private listeners: Array<(output: AgentOutput) => void> = [];
  private stopped = false;
  private command: string;
  private extraArgs: string[];
  private permissionMode: AcpPermissionMode;
  private sessionMode: AcpSessionMode;
  private usageWarnings?: UsageWarningThresholds;
  /** conversationId → acpSessionId (in-memory cache of disk store) */
  private sessionByConversation = new Map<string, string>();
  /** Prevent duplicate concurrent prompts for the same conversation. */
  private inflightByConversation = new Set<string>();
  private lastContextUsedByConversation = new Map<string, number>();

  constructor(opts: CursorAgentAcpOptions) {
    this.command = opts.command;
    this.extraArgs = sanitizeExtraArgs(opts.extraArgs ?? []);
    // Chat-only: always reject tools; prefer ask (Q&A) over full agent tools.
    this.permissionMode = "reject";
    this.sessionMode = "ask";
    void opts.permissionMode;
    void opts.sessionMode;
    this.usageWarnings = opts.usageWarnings;
  }

  onOutput(callback: (output: AgentOutput) => void): void {
    this.listeners.push(callback);
  }

  private emit(output: AgentOutput): void {
    if (output.kind === "status") {
      log.info(`[agent-acp] ${output.text}`, { listenerCount: this.listeners.length });
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

    // Never treat a oneshot resume id as an ACP session.
    if (options.sessionId && !options.sessionId.startsWith("acp:")) {
      this.emit({
        kind: "status",
        text: "Ignoring oneshot session id for ACP mode (separate-session policy).",
      });
    }

    this.client = new CursorAcpClient({
      command: this.command,
      extraArgs: this.extraArgs,
      cwd,
      permissionMode: "reject",
      sessionMode: "ask",
    });

    const { initMs } = await this.client.start();
    this.emit({
      kind: "status",
      text: `ACP ready (init ${initMs}ms, mode=ask). ${chatOnlyStatusLine(this.displayName)}`,
      sessionId: this.lastSessionId,
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
    if (this.stopped) throw new Error("ACP adapter stopped");
    const cwd = ensureChatRuntimeDir();
    const conversationId = turn?.conversationId || sessionId || "default";
    const turnId = randomUUID();

    if (this.inflightByConversation.has(conversationId)) {
      const msg =
        "A turn is already in progress for this conversation; duplicate prompt blocked (no second model submission).";
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
            text: "Recovering ACP process after unknown-completion crash (not replaying prior prompt).",
          });
        }
        // Drop stale in-memory live sessions — process is new.
        this.sessionByConversation.clear();
        client = new CursorAcpClient({
          command: this.command,
          extraArgs: this.extraArgs,
          cwd,
          permissionMode: "reject",
          sessionMode: "ask",
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
      this.lastSessionId = `acp:${acpSessionId}`;

      // Apply model when preference differs from last ACP-applied model (including default restore).
      const desiredModel = turn?.modelId; // undefined => CLI default
      const lastApplied = getAcpSession(conversationId)?.modelId;
      if (desiredModel !== lastApplied) {
        try {
          const applied = await client.setModel(acpSessionId, desiredModel);
          setAcpSession(conversationId, {
            acpSessionId,
            cwd,
            modelId: desiredModel === undefined ? undefined : applied,
          });
        } catch (err) {
          const msg = sanitizeForQq((err as Error).message);
          this.emit({ kind: "error", text: msg, sessionId: this.lastSessionId });
          hooks?.onFinal?.();
          return msg;
        }
      }

      try {
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
                text: `ACP permission: ${summary} (mode=${this.permissionMode})`,
                sessionId: this.lastSessionId,
              });
            },
          },
        );

        const latencyMs =
          metrics.finalAt && metrics.promptSentAt
            ? metrics.finalAt - metrics.promptSentAt
            : undefined;

        const usageRecord = buildTurnUsageRecord({
          turnId,
          backend: this.displayName,
          transport: "acp",
          modelId: turn?.modelId ?? getAcpSession(conversationId)?.modelId,
          sessionId: acpSessionId,
          conversationId,
          latencyMs,
          usageRaw: result?.usage,
          usageUpdates: metrics.usageUpdates,
          thresholds: this.usageWarnings,
          previousContextUsed: this.lastContextUsedByConversation.get(conversationId),
        });
        if (typeof usageRecord.tokens.contextUsed === "number") {
          this.lastContextUsedByConversation.set(
            conversationId,
            usageRecord.tokens.contextUsed,
          );
        }
        recordTurnUsage(usageRecord);

        log.info("acp:turn_metrics", {
          turnId,
          conversationFingerprint: usageRecord.conversationFingerprint,
          firstTextMs:
            metrics.firstTextAt && metrics.promptSentAt
              ? metrics.firstTextAt - metrics.promptSentAt
              : undefined,
          finalMs: latencyMs,
          toolCallNotifications: metrics.toolCallNotifications,
          assistantChunkCount: metrics.assistantChunkCount,
          modelRequestCount: usageRecord.modelRequestCount,
        });

        const clean = sanitizeForQq(text);
        this.emit({ kind: "final", text: clean, sessionId: this.lastSessionId });
        hooks?.onFinal?.();
        return clean;
      } catch (err) {
        const msg = sanitizeForQq((err as Error).message);
        this.emit({ kind: "error", text: msg, sessionId: this.lastSessionId });
        hooks?.onFinal?.();
        // If crash with unknown completion, drop client so next turn recovers fresh
        // without replaying this prompt.
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

  async stop(): Promise<void> {
    this.stopped = true;
    await this.client?.stop();
    this.client = undefined;
  }

  async attachTerminal(options: AgentOptions): Promise<number> {
    // ACP holds the persistent process; interactive attach uses oneshot resume UX is not shared.
    this.emit({
      kind: "status",
      text: "ACP mode: interactive terminal attach is not shared with the persistent ACP process. Use oneshot mode for dual terminal+QQ, or QQ-only with --no-terminal.",
    });
    void options;
    return 0;
  }

  async listModels(): Promise<ModelCatalog> {
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
          note: "Listed via Cursor Agent --list-models. ACP applies selection with session/set_config_option.",
        };
      }
      lastErr = text.trim() || `exit ${result.code}`;
    }
    return {
      backend: this.displayName,
      discovery: "unavailable",
      models: [],
      note: `Could not list models: ${lastErr.slice(0, 200)}`,
    };
  }

  async resolveModelSwitch(modelId: string | "default"): Promise<ModelSwitchResult> {
    if (modelId === "default" || modelId.toLowerCase() === "default") {
      return {
        ok: true,
        effectiveModelId: undefined,
        message:
          "Restored Cursor Agent default model for this conversation. ACP will apply it on the next turn via set_config_option.",
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
      message: `Switched to ${hit.id}. Next ACP turn will call session/set_config_option (same conversation session is kept).`,
    };
  }

  private async resolveSession(
    client: CursorAcpClient,
    conversationId: string,
    cwd: string,
    modelId?: string,
  ): Promise<string> {
    const mem = this.sessionByConversation.get(conversationId);
    if (mem && client.hasLiveSession(mem)) {
      return mem;
    }

    const stored = getAcpSession(conversationId);
    if (
      stored &&
      isPrivilegedSessionMeta({
        cwd: stored.cwd,
        chatOnlyVersion: stored.chatOnlyVersion,
      })
    ) {
      clearAcpSession(conversationId);
      this.sessionByConversation.delete(conversationId);
      this.emit({
        kind: "status",
        text: "Prior ACP session was not chat-only; starting a fresh isolated chat session.",
      });
    }

    const cached = mem || getAcpSession(conversationId)?.acpSessionId;

    if (cached) {
      try {
        const loaded = await client.sessionLoad(cached, cwd);
        this.sessionByConversation.set(conversationId, loaded.sessionId);
        setAcpSession(conversationId, {
          acpSessionId: loaded.sessionId,
          cwd,
          modelId: modelId ?? getAcpSession(conversationId)?.modelId,
        });
        return loaded.sessionId;
      } catch (err) {
        log.warn("acp:session_load_failed", {
          conversationId,
          message: (err as Error).message,
        });
        clearAcpSession(conversationId);
        this.sessionByConversation.delete(conversationId);
        this.emit({
          kind: "status",
          text: "ACP session/load failed; starting a new ACP session for this conversation (history not silently reused).",
        });
      }
    }

    const created = await client.sessionNew(cwd);
    this.sessionByConversation.set(conversationId, created.sessionId);
    setAcpSession(conversationId, {
      acpSessionId: created.sessionId,
      cwd,
      modelId,
    });
    return created.sessionId;
  }
}

export function createAgentAcpAdapter(
  command: string,
  extraArgs: string[],
  permissionMode: AcpPermissionMode = "reject",
  sessionMode: AcpSessionMode = "agent",
  usageWarnings?: UsageWarningThresholds,
): CursorAgentAcpAdapter {
  return new CursorAgentAcpAdapter({
    command,
    extraArgs,
    permissionMode,
    sessionMode,
    usageWarnings,
  });
}
