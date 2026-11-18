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
import { CodexAppServerClient } from "../codex/app-server-client.js";
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
import { parseCodexModelJson } from "../models/parse-list.js";
import { runCommand } from "../util/process.js";
import {
  chatOnlyStatusLine,
  ensureChatRuntimeDir,
  isPrivilegedSessionMeta,
  sanitizeExtraArgs,
} from "../security/chat-only.js";
import {
  assertCodexRestrictedReadyForQq,
  ensureCodexQqHome,
} from "../security/codex-restricted.js";
import { loadPersona } from "../persona/load.js";
import { getMemoryManager } from "../memory/manager.js";
import { getCultureManager } from "../culture/manager.js";
import { assembleBridgeContext } from "../context/assemble.js";
import { formatBridgeActionsSection } from "../bridge/recent-actions.js";

const TRANSPORT = "codex-app-server" as const;

export interface CodexAppServerAdapterOptions {
  command: string;
  extraArgs?: string[];
  usageWarnings?: UsageWarningThresholds;
  /** Prefer read-only sandbox for QQ. */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

/**
 * Persistent Codex via `codex app-server --stdio` in QQ-restricted mode:
 * isolated CODEX_HOME, local tools disabled, hosted web_search only,
 * Bridge rejects approvals, Persona/Memory/Culture via developerInstructions.
 */
export class CodexAppServerAdapter implements AgentAdapter {
  readonly kind: AgentKind = "codex";
  readonly displayName = "Codex CLI (app-server, restricted)";
  readonly supportsSessionResume = true;

  private options?: AgentOptions;
  private command: string;
  private extraArgs: string[];
  private usageWarnings?: UsageWarningThresholds;
  private sandbox: "read-only" | "workspace-write" | "danger-full-access";
  private listeners: Array<(output: AgentOutput) => void> = [];
  private stopped = false;
  private client?: CodexAppServerClient;
  private lastSessionId?: string;
  private threadByConversation = new Map<string, string>();
  private inflightByConversation = new Set<string>();
  /** Context profile hashes at thread start (inject once; refresh via new thread). */
  private contextAtStart = new Map<
    string,
    { memory: string; culture: string; persona: string; capability: string }
  >();
  private codexHome = "";
  /** Bump when capability framing changes so old threads are not resumed with stale text. */
  private static readonly CAPABILITY_KEY = "codex-restricted-websearch-bridge-actions-v4";

  constructor(opts: CodexAppServerAdapterOptions) {
    this.command = opts.command;
    this.extraArgs = sanitizeExtraArgs(opts.extraArgs ?? []);
    this.usageWarnings = opts.usageWarnings;
    // Chat-only: always read-only (ignore opts.sandbox).
    this.sandbox = "read-only";
    void opts.sandbox;
  }

  onOutput(callback: (output: AgentOutput) => void): void {
    this.listeners.push(callback);
  }

  private emit(output: AgentOutput): void {
    if (output.kind === "status") {
      log.info(`[codex-app-server] ${output.text}`);
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
    if (options.sessionId && !options.sessionId.startsWith("codex-app:")) {
      this.emit({
        kind: "status",
        text: "Ignoring oneshot/exec session id for Codex app-server (separate-session policy).",
      });
    }

    // Fail closed: isolated home + verify marker required before QQ use.
    const home = assertCodexRestrictedReadyForQq();
    this.codexHome = home.homeDir;
    ensureCodexQqHome();

    this.client = new CodexAppServerClient({
      command: this.command,
      extraArgs: this.extraArgs,
      cwd,
      approvalPolicy: "on-request",
      sandbox: "read-only",
      restricted: true,
      codexHome: this.codexHome,
    });
    const { initMs } = await this.client.start();
    this.emit({
      kind: "status",
      text: `Codex restricted app-server ready (init ${initMs}ms; home=${this.codexHome}). ${chatOnlyStatusLine(this.displayName)}`,
    });
  }

  private buildDeveloperInstructions(conversationId: string): {
    text: string;
    memoryHash: string;
    cultureHash: string;
    personaHash: string;
    capability: string;
  } {
    const persona = loadPersona();
    // Memory/Culture retrieval only — do not use Claude-oriented composed file framing.
    const memBundle = getMemoryManager().buildSessionContext(conversationId, {});
    const cultureBundle = getCultureManager().buildCultureSection(conversationId, {
      queryHints: getCultureManager().store.getLastQuery(conversationId),
    });
    // Critical: capabilityProfile=codex-restricted so Persona framing does NOT say "no tools"
    // (that conflict made the model refuse hosted web_search in live QQ).
    const assembled = assembleBridgeContext({
      personaBody: persona.text,
      memorySection: memBundle.memorySection || undefined,
      cultureSection: cultureBundle.cultureSection || undefined,
      bridgeActionsSection: formatBridgeActionsSection(conversationId) || undefined,
      capabilityProfile: "codex-restricted",
    });
    return {
      text: assembled.fullText,
      memoryHash: getMemoryManager().currentMemoryHash(conversationId),
      cultureHash: getCultureManager().currentCultureHash(conversationId),
      personaHash: persona.hash,
      capability: CodexAppServerAdapter.CAPABILITY_KEY,
    };
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
    if (this.stopped) throw new Error("Codex app-server adapter stopped");
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
            text: "Recovering Codex app-server after unknown-completion crash (not replaying prior prompt).",
          });
        }
        this.threadByConversation.clear();
        const home = assertCodexRestrictedReadyForQq();
        this.codexHome = home.homeDir;
        client = new CodexAppServerClient({
          command: this.command,
          extraArgs: this.extraArgs,
          cwd,
          approvalPolicy: "on-request",
          sandbox: "read-only",
          restricted: true,
          codexHome: this.codexHome,
        });
        this.client = client;
        await client.start();
        client.clearCrashLatch();
      }

      hooks?.onSpawn?.();
      // Note utterance for Culture retrieval before assembling developer instructions.
      try {
        getCultureManager().noteUserText(conversationId, message);
      } catch {
        // optional
      }
      const threadId = await this.resolveThread(
        client,
        conversationId,
        cwd,
        turn?.modelId,
      );
      this.lastSessionId = `codex-app:${threadId}`;

      try {
        const { text, usage, metrics } = await client.turnStart(threadId, message, {
          model: turn?.modelId,
          handlers: {
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
                text: `Codex permission rejected: ${summary}`,
                sessionId: this.lastSessionId,
              });
            },
            onForbiddenTool: (summary) => {
              this.emit({
                kind: "error",
                text: `Blocked forbidden Codex tool: ${summary}`,
                sessionId: this.lastSessionId,
              });
            },
          },
        });

        const latencyMs =
          metrics.finalAt && metrics.promptSentAt
            ? metrics.finalAt - metrics.promptSentAt
            : undefined;

        // cachedInputTokens is not added on top of inputTokens.
        recordTurnUsage(
          buildTurnUsageRecord({
            turnId,
            backend: this.displayName,
            transport: "unknown",
            modelId: turn?.modelId,
            sessionId: threadId,
            conversationId,
            latencyMs,
            usageRaw: usage
              ? {
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  cachedReadTokens: usage.cachedInputTokens,
                  cachedWriteTokens: usage.cacheWriteInputTokens,
                  thoughtTokens: usage.reasoningOutputTokens,
                  totalTokens: usage.totalTokens,
                }
              : undefined,
            thresholds: this.usageWarnings,
          }),
        );

        log.info("codex-app-server:turn_metrics", {
          turnId,
          firstTextMs:
            metrics.firstTextAt && metrics.promptSentAt
              ? metrics.firstTextAt - metrics.promptSentAt
              : undefined,
          finalMs: latencyMs,
          pid: client.pid,
        });

        const clean = sanitizeForQq(text);
        if (!clean) {
          const err = "Codex returned no assistant message for this turn.";
          this.emit({ kind: "error", text: err, sessionId: this.lastSessionId });
          hooks?.onFinal?.();
          return err;
        }
        if (
          /^\s*\{"type":"/.test(clean) ||
          /^\s*\{"jsonrpc":/.test(clean) ||
          /thread\/started|turn\/completed/.test(clean)
        ) {
          log.error("codex-app-server:refusing_protocol_leak", {
            preview: clean.slice(0, 80),
          });
          const safe = "Codex returned no readable assistant message for this turn.";
          this.emit({ kind: "error", text: safe, sessionId: this.lastSessionId });
          hooks?.onFinal?.();
          return safe;
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
          this.threadByConversation.clear();
        }
        return msg;
      }
    } finally {
      this.inflightByConversation.delete(conversationId);
    }
  }

  private async resolveThread(
    client: CodexAppServerClient,
    conversationId: string,
    cwd: string,
    modelId?: string,
  ): Promise<string> {
    const ctx = this.buildDeveloperInstructions(conversationId);
    client.setDeveloperInstructions(ctx.text);

    const started = this.contextAtStart.get(conversationId);
    const profileChanged =
      !!started &&
      (started.memory !== ctx.memoryHash ||
        started.culture !== ctx.cultureHash ||
        started.persona !== ctx.personaHash ||
        started.capability !== ctx.capability);

    const mem = this.threadByConversation.get(conversationId);
    if (mem && !profileChanged) return mem;
    if (mem && profileChanged) {
      this.emit({
        kind: "status",
        text: "Persona/Memory/Culture/capabilities changed; starting a fresh Codex thread with updated developerInstructions.",
      });
      this.threadByConversation.delete(conversationId);
      clearPersistentSession(TRANSPORT, conversationId);
    }

    const stored = getPersistentSession(TRANSPORT, conversationId);
    if (
      stored &&
      isPrivilegedSessionMeta({
        cwd: stored.cwd,
        chatOnlyVersion: stored.chatOnlyVersion,
      })
    ) {
      this.emit({
        kind: "status",
        text: "Prior Codex thread was not chat-only; starting a fresh isolated chat thread.",
      });
      clearPersistentSession(TRANSPORT, conversationId);
    }
    const safeStored = getPersistentSession(TRANSPORT, conversationId);
    if (
      safeStored?.sessionId &&
      safeStored.capabilityKey !== ctx.capability
    ) {
      this.emit({
        kind: "status",
        text: "Prior Codex thread used outdated Chat-only capability framing; starting a fresh thread so hosted web_search is available.",
      });
      clearPersistentSession(TRANSPORT, conversationId);
    }
    const resumable = getPersistentSession(TRANSPORT, conversationId);
    if (resumable?.sessionId && !profileChanged) {
      try {
        const { threadId } = await client.threadResume(resumable.sessionId, {
          cwd,
          model: modelId,
          developerInstructions: ctx.text,
        });
        this.threadByConversation.set(conversationId, threadId);
        this.contextAtStart.set(conversationId, {
          memory: ctx.memoryHash,
          culture: ctx.cultureHash,
          persona: ctx.personaHash,
          capability: ctx.capability,
        });
        setPersistentSession(TRANSPORT, conversationId, {
          sessionId: threadId,
          cwd,
          modelId,
          personaHash: ctx.personaHash,
          capabilityKey: ctx.capability,
        });
        return threadId;
      } catch (err) {
        log.warn("codex-app-server:thread_resume_failed", {
          message: (err as Error).message,
        });
        this.emit({
          kind: "status",
          text: "Could not resume prior Codex thread; starting a new thread (history not silently migrated).",
        });
        clearPersistentSession(TRANSPORT, conversationId);
      }
    }

    const { threadId } = await client.threadStart({
      cwd,
      model: modelId,
      developerInstructions: ctx.text,
    });
    this.threadByConversation.set(conversationId, threadId);
    this.contextAtStart.set(conversationId, {
      memory: ctx.memoryHash,
      culture: ctx.cultureHash,
      persona: ctx.personaHash,
      capability: ctx.capability,
    });
    setPersistentSession(TRANSPORT, conversationId, {
      sessionId: threadId,
      cwd,
      modelId,
      personaHash: ctx.personaHash,
      capabilityKey: ctx.capability,
    });
    return threadId;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.client?.stop();
    this.client = undefined;
    this.threadByConversation.clear();
    this.contextAtStart.clear();
  }

  async attachTerminal(options: AgentOptions): Promise<number> {
    this.emit({
      kind: "status",
      text: "Codex app-server mode: interactive terminal is not shared with the persistent process. Use oneshot for dual terminal+QQ, or --no-terminal.",
    });
    void options;
    return 0;
  }

  async listModels(): Promise<ModelCatalog> {
    if (this.client?.isReady) {
      const models = await this.client.listModels();
      if (models.length > 0) {
        return {
          backend: this.displayName,
          discovery: "dynamic",
          models: models.map((m) => ({
            id: m.id,
            displayName: m.displayName ?? m.id,
          })),
          note: "Listed via Codex app-server model/list.",
        };
      }
    }
    // Fallback to CLI debug models (same as oneshot).
    const cwd = this.options?.cwd ?? process.cwd();
    try {
      const result = await runCommand(
        this.command,
        [...this.extraArgs, "debug", "models"],
        { cwd, timeoutMs: 60_000 },
      );
      const parsed = parseCodexModelJson(result.stdout || result.stderr);
      if (parsed.length > 0) {
        return {
          backend: this.displayName,
          discovery: "dynamic",
          models: parsed,
          note: "Listed via `codex debug models` (app-server model/list empty).",
        };
      }
    } catch {
      // ignore
    }
    return {
      backend: this.displayName,
      discovery: "unavailable",
      models: [],
      note: "Could not list Codex models.",
    };
  }

  async resolveModelSwitch(modelId: string | "default"): Promise<ModelSwitchResult> {
    if (modelId === "default") {
      return {
        ok: true,
        effectiveModelId: undefined,
        message: "Restored CLI default for subsequent Codex turns.",
      };
    }
    return {
      ok: true,
      effectiveModelId: modelId,
      message: `Will pass model=${modelId} on the next turn/start (sticky for subsequent turns).`,
    };
  }
}

export function createCodexAppServerAdapter(
  command: string,
  extraArgs: string[],
  usageWarnings?: UsageWarningThresholds,
): CodexAppServerAdapter {
  return new CodexAppServerAdapter({ command, extraArgs, usageWarnings });
}
