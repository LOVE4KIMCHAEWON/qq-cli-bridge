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
import { ClaudeStreamClient } from "../claude/stream-client.js";
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
import {
  chatOnlyStatusLine,
  ensureChatRuntimeDir,
  isPrivilegedSessionMeta,
  sanitizeExtraArgs,
} from "../security/chat-only.js";
import { loadPersona, personaStatusLine } from "../persona/load.js";
import { getMemoryManager } from "../memory/manager.js";
import { getCultureManager } from "../culture/manager.js";
import { writeBridgeSessionPrompt } from "../context/session-prompt.js";

const TRANSPORT = "claude-stream" as const;

export interface ClaudeStreamAdapterOptions {
  command: string;
  extraArgs?: string[];
  usageWarnings?: UsageWarningThresholds;
  /** Test seam: build stream clients (e.g. with fake spawnProcess). */
  clientFactory?: (opts: {
    command: string;
    extraArgs: string[];
    cwd: string;
    permissionMode: string;
  }) => ClaudeStreamClient;
}

/**
 * Persistent Claude Code via stream-json (process reused across QQ turns).
 * Oneshot `ClaudeAdapter` remains the fallback when transport=oneshot.
 */
export class ClaudeStreamAdapter implements AgentAdapter {
  readonly kind: AgentKind = "claude";
  readonly displayName = "Claude Code (stream)";
  readonly supportsSessionResume = true;

  private options?: AgentOptions;
  private command: string;
  private extraArgs: string[];
  private usageWarnings?: UsageWarningThresholds;
  private clientFactory?: ClaudeStreamAdapterOptions["clientFactory"];
  private listeners: Array<(output: AgentOutput) => void> = [];
  private stopped = false;
  /** One live process per QQ conversation (Claude stream-json = one session/process). */
  private clients = new Map<string, ClaudeStreamClient>();
  private lastSessionId?: string;
  private inflightByConversation = new Set<string>();
  /** Model applied at process start for each conversation. */
  private modelAtStart = new Map<string, string | undefined>();
  /** Persona hash applied at process start for each conversation. */
  private personaAtStart = new Map<string, string>();
  /** Memory profile hash applied at process start (not re-injected every turn). */
  private memoryAtStart = new Map<string, string>();
  /** Culture profile hash applied at process start (not re-injected every turn). */
  private cultureAtStart = new Map<string, string>();
  /** Models last used per conversation (for rotation restarts). */
  private lastModelId = new Map<string, string | undefined>();

  constructor(opts: ClaudeStreamAdapterOptions) {
    this.command = opts.command;
    this.extraArgs = sanitizeExtraArgs(opts.extraArgs ?? []);
    this.usageWarnings = opts.usageWarnings;
    this.clientFactory = opts.clientFactory;
  }

  onOutput(callback: (output: AgentOutput) => void): void {
    this.listeners.push(callback);
  }

  private emit(output: AgentOutput): void {
    if (output.kind === "status") {
      log.info(`[claude-stream] ${output.text}`);
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
    if (options.sessionId && !options.sessionId.startsWith("claude-stream:")) {
      this.emit({
        kind: "status",
        text: "Ignoring oneshot session id for Claude stream mode (separate-session policy).",
      });
    }
    const persona = loadPersona();
    this.emit({
      kind: "status",
      text: `Claude stream ready. ${chatOnlyStatusLine(this.displayName)} ${personaStatusLine(persona)}`,
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
    if (this.stopped) throw new Error("Claude stream adapter stopped");
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
      hooks?.onSpawn?.();
      const client = await this.ensureClient(conversationId, cwd, turn?.modelId);
      const { text, sessionId: sid, usage, metrics } = await client.prompt(message, {
        modelId: turn?.modelId,
        handlers: {
          onPartialText: (chunk) => {
            this.emit({
              kind: "partial",
              text: chunk,
              sessionId: this.lastSessionId,
            });
          },
        },
      });

      if (sid) {
        this.lastSessionId = `claude-stream:${sid}`;
        setPersistentSession(TRANSPORT, conversationId, {
          sessionId: sid,
          cwd,
          modelId: turn?.modelId,
          personaHash: this.personaAtStart.get(conversationId),
        });
      }

      const latencyMs =
        metrics.finalAt && metrics.promptSentAt
          ? metrics.finalAt - metrics.promptSentAt
          : undefined;

      recordTurnUsage(
        buildTurnUsageRecord({
          turnId,
          backend: this.displayName,
          transport: "unknown",
          modelId: turn?.modelId,
          sessionId: sid,
          conversationId,
          latencyMs,
          usageRaw: usage
            ? {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cachedReadTokens: usage.cacheReadTokens,
                cachedWriteTokens: usage.cacheWriteTokens,
                thoughtTokens: usage.thoughtTokens,
              }
            : undefined,
          thresholds: this.usageWarnings,
        }),
      );

      getMemoryManager().noteClaudeUsage(
        conversationId,
        usage?.inputTokens,
        sid,
      );
      this.lastModelId.set(conversationId, turn?.modelId);

      log.info("claude-stream:turn_metrics", {
        turnId,
        firstTextMs:
          metrics.firstTextAt && metrics.promptSentAt
            ? metrics.firstTextAt - metrics.promptSentAt
            : undefined,
        finalMs: latencyMs,
        pid: client.pid,
        processReused: (client.initDurationMs ?? 0) === 0 || true,
      });

      const clean = sanitizeForQq(text);
      if (!clean) {
        const err = "Claude returned no assistant message for this turn.";
        this.emit({ kind: "error", text: err, sessionId: this.lastSessionId });
        hooks?.onFinal?.();
        return err;
      }
      if (/^\s*\{"type":"/.test(clean) || /stream-json|session_id/.test(clean)) {
        log.error("claude-stream:refusing_protocol_leak", {
          preview: clean.slice(0, 80),
        });
        const safe = "Claude returned no readable assistant message for this turn.";
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
      const client = this.clients.get(conversationId);
      if (client?.lastTurnCompletionUnknown) {
        await client.stop().catch(() => undefined);
        this.clients.delete(conversationId);
        this.modelAtStart.delete(conversationId);
        this.personaAtStart.delete(conversationId);
        this.memoryAtStart.delete(conversationId);
        this.cultureAtStart.delete(conversationId);
      }
      return msg;
    } finally {
      this.inflightByConversation.delete(conversationId);
    }
  }

  /**
   * After a completed turn + memory commit: rotate Claude session if context budget exceeded.
   * Never called mid-turn. On failure, keeps the existing session.
   */
  async maybeRotateSession(conversationId: string): Promise<boolean> {
    const memory = getMemoryManager();
    const culture = getCultureManager();
    if (!memory.shouldRotate(conversationId)) return false;
    if (this.inflightByConversation.has(conversationId)) return false;

    const cwd = ensureChatRuntimeDir();
    const modelId = this.lastModelId.get(conversationId) ?? this.modelAtStart.get(conversationId);
    const old = this.clients.get(conversationId);
    const persona = loadPersona();
    const prompt = writeBridgeSessionPrompt(persona.text, conversationId, {
      includeCarryOverNote: true,
    });

    this.emit({
      kind: "status",
      text: `Context budget reached; rotating Claude session (carry-over tokens≈${prompt.memory.estimatedTokens}).`,
    });

    const clientOpts = {
      command: this.command,
      extraArgs: this.extraArgs,
      cwd,
      permissionMode: "dontAsk",
    };
    const next = this.clientFactory
      ? this.clientFactory(clientOpts)
      : new ClaudeStreamClient(clientOpts);

    try {
      // New Chat-only session (no --resume) with Persona + Memory + Culture carry-over.
      await next.start({
        modelId,
        systemPromptFile: prompt.path,
        forkSession: false,
      });
    } catch (err) {
      await next.stop().catch(() => undefined);
      this.emit({
        kind: "status",
        text: `Session rotation failed; keeping existing Claude session. (${sanitizeForQq((err as Error).message).slice(0, 120)})`,
      });
      return false;
    }

    // Atomic activate: only swap after successful init.
    if (old) {
      await old.stop().catch(() => undefined);
    }
    this.clients.set(conversationId, next);
    this.modelAtStart.set(conversationId, modelId);
    this.personaAtStart.set(conversationId, persona.hash);
    this.memoryAtStart.set(conversationId, memory.currentMemoryHash(conversationId));
    this.cultureAtStart.set(conversationId, culture.currentCultureHash(conversationId));
    memory.resetSessionTokenEstimate(conversationId);
    memory.noteClaudeUsage(
      conversationId,
      prompt.memory.estimatedTokens,
      next.currentSessionId,
    );

    if (next.currentSessionId) {
      this.lastSessionId = `claude-stream:${next.currentSessionId}`;
      setPersistentSession(TRANSPORT, conversationId, {
        sessionId: next.currentSessionId,
        cwd,
        modelId,
        personaHash: persona.hash,
      });
    } else {
      clearPersistentSession(TRANSPORT, conversationId);
    }
    this.emit({
      kind: "status",
      text: "Claude session rotated successfully with Persona + Memory carry-over.",
    });
    return true;
  }

  private async ensureClient(
    conversationId: string,
    cwd: string,
    modelId?: string,
  ): Promise<ClaudeStreamClient> {
    let client = this.clients.get(conversationId);
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
        text: "Prior Claude session was not chat-only; starting a fresh isolated chat session.",
      });
      clearPersistentSession(TRANSPORT, conversationId);
    }
    const safeStored = getPersistentSession(TRANSPORT, conversationId);
    const startedModel = this.modelAtStart.get(conversationId);
    const persona = loadPersona();
    const memory = getMemoryManager();
    const culture = getCultureManager();
    const startedPersona = this.personaAtStart.get(conversationId);
    const startedMemory = this.memoryAtStart.get(conversationId);
    const startedCulture = this.cultureAtStart.get(conversationId);
    const storedPersona = safeStored?.personaHash;

    // Model switch on a live process: restart with --model (cannot silently keep old model).
    if (client?.isReady && modelId !== startedModel && modelId !== undefined) {
      this.emit({
        kind: "status",
        text: `Model change requires restarting Claude stream process (preserving session via --resume).`,
      });
      const resume = client.currentSessionId ?? safeStored?.sessionId;
      await client.stop().catch(() => undefined);
      this.clients.delete(conversationId);
      this.personaAtStart.delete(conversationId);
      this.memoryAtStart.delete(conversationId);
      this.cultureAtStart.delete(conversationId);
      client = undefined;
      if (resume) {
        setPersistentSession(TRANSPORT, conversationId, {
          sessionId: resume,
          cwd,
          modelId,
          personaHash: startedPersona ?? storedPersona,
        });
      }
    }

    // Persona / memory / culture profile changed: restart + fork so system prompt updates without dropping history.
    const personaChangedLive =
      client?.isReady && startedPersona !== undefined && startedPersona !== persona.hash;
    const personaChangedStored =
      !client?.isReady &&
      !!safeStored?.sessionId &&
      storedPersona !== undefined &&
      storedPersona !== persona.hash;
    const memoryChangedLive =
      client?.isReady &&
      startedMemory !== undefined &&
      memory.memoryHashChanged(conversationId, startedMemory);
    const cultureChangedLive =
      client?.isReady &&
      startedCulture !== undefined &&
      culture.cultureHashChanged(conversationId, startedCulture);
    if (personaChangedLive || personaChangedStored || memoryChangedLive || cultureChangedLive) {
      this.emit({
        kind: "status",
        text: cultureChangedLive
          ? "Culture KB changed; restarting Claude with --resume --fork-session (history kept)."
          : memoryChangedLive
            ? "Memory profile changed; restarting Claude with --resume --fork-session (history kept)."
            : "Persona file changed; restarting Claude with --resume --fork-session so the new Persona applies without discarding history.",
      });
      const resume =
        client?.currentSessionId ?? getPersistentSession(TRANSPORT, conversationId)?.sessionId;
      if (client) {
        await client.stop().catch(() => undefined);
        this.clients.delete(conversationId);
        this.personaAtStart.delete(conversationId);
        this.memoryAtStart.delete(conversationId);
        this.cultureAtStart.delete(conversationId);
        client = undefined;
      }
      if (resume) {
        setPersistentSession(TRANSPORT, conversationId, {
          sessionId: resume,
          cwd,
          modelId,
          personaHash: storedPersona ?? startedPersona,
        });
      }
    }

    if (client?.isReady) return client;

    if (client?.lastTurnCompletionUnknown) {
      this.emit({
        kind: "status",
        text: "Recovering Claude stream after unknown-completion crash (not replaying prior prompt).",
      });
    }

    const rotateFresh =
      memory.shouldRotate(conversationId) && !!getPersistentSession(TRANSPORT, conversationId);

    const prompt = writeBridgeSessionPrompt(persona.text, conversationId, {
      includeCarryOverNote: rotateFresh,
    });

    if (rotateFresh) {
      this.emit({
        kind: "status",
        text: "Starting a fresh Claude session with Memory + Culture carry-over (context threshold).",
      });
      clearPersistentSession(TRANSPORT, conversationId);
    }

    const clientOpts = {
      command: this.command,
      extraArgs: this.extraArgs,
      cwd,
      permissionMode: "dontAsk",
    };
    client = this.clientFactory
      ? this.clientFactory(clientOpts)
      : new ClaudeStreamClient(clientOpts);
    this.clients.set(conversationId, client);

    const resumeEntry = getPersistentSession(TRANSPORT, conversationId);
    const resume = rotateFresh ? undefined : resumeEntry?.sessionId;
    // Fork when Persona/Memory/Culture changed so system-prompt snapshot picks up all sections.
    const forkForPrompt =
      !!resume &&
      (resumeEntry?.personaHash === undefined ||
        resumeEntry.personaHash !== persona.hash ||
        memory.memoryHashChanged(conversationId, startedMemory) ||
        culture.cultureHashChanged(conversationId, startedCulture));

    await client.start({
      resume,
      modelId,
      systemPromptFile: prompt.path,
      forkSession: forkForPrompt,
    });
    this.modelAtStart.set(conversationId, modelId);
    this.personaAtStart.set(conversationId, persona.hash);
    this.memoryAtStart.set(conversationId, memory.currentMemoryHash(conversationId));
    this.cultureAtStart.set(conversationId, culture.currentCultureHash(conversationId));
    if (rotateFresh) {
      memory.resetSessionTokenEstimate(conversationId);
    }
    if (client.currentSessionId) {
      this.lastSessionId = `claude-stream:${client.currentSessionId}`;
      setPersistentSession(TRANSPORT, conversationId, {
        sessionId: client.currentSessionId,
        cwd,
        modelId,
        personaHash: persona.hash,
      });
    }
    return client;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const stops = [...this.clients.values()].map((c) => c.stop());
    this.clients.clear();
    this.modelAtStart.clear();
    this.personaAtStart.clear();
    this.memoryAtStart.clear();
    this.cultureAtStart.clear();
    this.lastModelId.clear();
    await Promise.all(stops);
  }

  async attachTerminal(options: AgentOptions): Promise<number> {
    this.emit({
      kind: "status",
      text: "Claude stream mode: interactive terminal is not shared with the persistent process. Use oneshot for dual terminal+QQ, or --no-terminal.",
    });
    void options;
    return 0;
  }

  async listModels(): Promise<ModelCatalog> {
    return {
      backend: this.displayName,
      discovery: "documented-aliases",
      note:
        "Claude Code has no non-interactive account model catalog. Aliases from claude --help. Stream mode restarts the process with --model when switching.",
      models: [
        { id: "sonnet", displayName: "Sonnet (alias)", isDefault: true },
        { id: "opus", displayName: "Opus (alias)" },
        { id: "fable", displayName: "Fable (alias)" },
      ],
    };
  }

  async resolveModelSwitch(modelId: string | "default"): Promise<ModelSwitchResult> {
    if (modelId === "default") {
      return {
        ok: true,
        effectiveModelId: undefined,
        message:
          "Restored CLI default. Next turn may restart the stream process without --model.",
      };
    }
    const catalog = await this.listModels();
    const hit = catalog.models.find((m) => m.id === modelId);
    return {
      ok: true,
      effectiveModelId: modelId,
      message: hit
        ? `Will apply --model ${modelId} (may restart stream process; history resumed via --resume).`
        : `Model id accepted as-is (not in documented aliases). May restart stream process.`,
    };
  }
}

export function createClaudeStreamAdapter(
  command: string,
  extraArgs: string[],
  usageWarnings?: UsageWarningThresholds,
): ClaudeStreamAdapter {
  return new ClaudeStreamAdapter({ command, extraArgs, usageWarnings });
}

/** Test helper — clear a stored stream session. */
export function clearClaudeStreamSession(conversationId: string): void {
  clearPersistentSession(TRANSPORT, conversationId);
}
