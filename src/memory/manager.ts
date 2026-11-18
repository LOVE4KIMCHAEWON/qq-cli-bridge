import fs from "node:fs";
import { composeClaudeSystemPrompt, composedSystemPromptPath } from "../persona/load.js";
import { ensureDataDirs } from "../paths.js";
import { log } from "../util/logger.js";
import { globalTurnLock } from "../bridge/turn-lock.js";
import { buildSessionContext, memoryProfileHash } from "./context.js";
import { extractMemoriesFromUserText } from "./extract.js";
import { MemoryStore } from "./store.js";
import { estimateTokens } from "./tokens.js";
import {
  DEFAULT_MEMORY_CONFIG,
  type CarryOverBundle,
  type MemoryConfig,
  type MemoryItem,
  type SessionContextBundle,
} from "./types.js";

export type MemoryManagerOptions = {
  config?: Partial<MemoryConfig>;
  store?: MemoryStore;
  dbPath?: string;
};

/**
 * Bridge-owned Memory Manager.
 * Persona = how; Memory = what; Claude session = temporary execution context.
 */
export class MemoryManager {
  readonly config: MemoryConfig;
  readonly store: MemoryStore;
  private lastActivityAt = Date.now();
  private lastMaintenanceAt = 0;
  private maintenanceTimer?: NodeJS.Timeout;
  private maintenanceRunning = false;
  private closed = false;

  constructor(opts: MemoryManagerOptions = {}) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...opts.config };
    this.store =
      opts.store ??
      new MemoryStore({
        dbPath: opts.dbPath,
      });
  }

  close(): void {
    this.closed = true;
    if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
    this.store.close();
  }

  notifyActivity(): void {
    this.lastActivityAt = Date.now();
    this.scheduleIdleMaintenance();
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  commitTurn(input: {
    conversationId: string;
    userText: string;
    assistantText: string;
    qqMessageId?: string;
  }): { deduped: boolean } {
    if (!this.config.enabled) return { deduped: false };
    this.notifyActivity();
    const result = this.store.commitTurnPair(input);
    // Lightweight inline extraction for explicit remember cues only (non-blocking, no model).
    if (!result.deduped) {
      for (const mem of extractMemoriesFromUserText(input.userText)) {
        this.store.upsertMemory({
          conversationId: input.conversationId,
          kind: mem.kind,
          content: mem.content,
          source: "deterministic-inline",
        });
      }
      const metrics = this.store.getSessionMetrics(input.conversationId);
      this.store.setSessionMetrics(input.conversationId, {
        turnCount: metrics.turnCount + 1,
        estimatedTokens:
          metrics.estimatedTokens +
          estimateTokens(input.userText) +
          estimateTokens(input.assistantText),
        memoryHash: memoryProfileHash(this.store, input.conversationId),
      });
    }
    return { deduped: result.deduped };
  }

  listMemories(conversationId: string): MemoryItem[] {
    return this.store.listActiveMemories(conversationId, this.config.maxMemoryItems);
  }

  forgetMemory(conversationId: string, id: number): boolean {
    return this.store.deactivateMemory(id, conversationId);
  }

  correctMemory(conversationId: string, id: number, content: string): MemoryItem | null {
    return this.store.correctMemory(id, conversationId, content);
  }

  clearMemories(conversationId: string): number {
    return this.store.clearMemories(conversationId);
  }

  buildSessionContext(
    conversationId: string,
    opts: { queryHints?: string; includeCarryOverNote?: boolean } = {},
  ): SessionContextBundle {
    if (!this.config.enabled) {
      return {
        memorySection: "",
        memoryHash: "disabled",
        estimatedTokens: 0,
        recentTurnCount: 0,
        retrievalCount: 0,
        activeMemoryCount: 0,
      };
    }
    return buildSessionContext(this.store, conversationId, this.config, opts);
  }

  buildCarryOver(conversationId: string, queryHints?: string): CarryOverBundle {
    const base = this.buildSessionContext(conversationId, {
      queryHints,
      includeCarryOverNote: true,
    });
    return {
      ...base,
      summaryLine: `carry-over tokens≈${base.estimatedTokens} memories=${base.activeMemoryCount} recent=${base.recentTurnCount}`,
    };
  }

  /**
   * Write Persona + Memory (+ optional Culture) into the shared system-prompt file path.
   * Called only when starting/rotating a backend session — not every turn.
   * Culture section is supplied by the Bridge caller (CultureManager) so Memory
   * does not own Culture KB data.
   */
  writeSystemPromptFile(personaBody: string, conversationId: string, opts?: {
    queryHints?: string;
    includeCarryOverNote?: boolean;
    cultureSection?: string;
  }): { path: string; bundle: SessionContextBundle } {
    const bundle = this.buildSessionContext(conversationId, opts);
    ensureDataDirs();
    const out = composedSystemPromptPath();
    const composed = composeClaudeSystemPrompt({
      personaBody,
      memorySection: bundle.memorySection || undefined,
      cultureSection: opts?.cultureSection || undefined,
    });
    fs.writeFileSync(out, composed, "utf8");
    this.store.setSessionMetrics(conversationId, {
      memoryHash: bundle.memoryHash,
      estimatedTokens: Math.max(
        this.store.getSessionMetrics(conversationId).estimatedTokens,
        bundle.estimatedTokens,
      ),
    });
    return { path: out, bundle };
  }

  noteClaudeUsage(conversationId: string, inputTokens?: number, sessionId?: string): void {
    if (!this.config.enabled) return;
    const cur = this.store.getSessionMetrics(conversationId);
    const next = Math.max(cur.estimatedTokens, inputTokens ?? 0);
    this.store.setSessionMetrics(conversationId, {
      estimatedTokens: next,
      claudeSessionId: sessionId,
      memoryHash: memoryProfileHash(this.store, conversationId),
    });
  }

  shouldRotate(conversationId: string): boolean {
    if (!this.config.enabled) return false;
    const { estimatedTokens } = this.store.getSessionMetrics(conversationId);
    return estimatedTokens >= this.config.rotationThresholdTokens;
  }

  memoryHashChanged(conversationId: string, appliedHash?: string): boolean {
    if (!this.config.enabled || !appliedHash) return false;
    return appliedHash !== memoryProfileHash(this.store, conversationId);
  }

  currentMemoryHash(conversationId: string): string {
    return memoryProfileHash(this.store, conversationId);
  }

  resetSessionTokenEstimate(conversationId: string): void {
    this.store.setSessionMetrics(conversationId, {
      estimatedTokens: 0,
      turnCount: 0,
      claudeSessionId: null,
      memoryHash: memoryProfileHash(this.store, conversationId),
    });
  }

  /**
   * Idle-time deterministic maintenance. Never calls Claude.
   * Skips when a turn lock is held or activity is recent.
   */
  runMaintenance(conversationId?: string): {
    processed: number;
    upserted: number;
    skippedBusy: boolean;
  } {
    if (!this.config.enabled || this.closed) {
      return { processed: 0, upserted: 0, skippedBusy: false };
    }
    if (this.maintenanceRunning) {
      return { processed: 0, upserted: 0, skippedBusy: true };
    }
    if (globalTurnLock.isBusy()) {
      return { processed: 0, upserted: 0, skippedBusy: true };
    }
    if (Date.now() - this.lastActivityAt < this.config.maintenanceIdleMs) {
      return { processed: 0, upserted: 0, skippedBusy: true };
    }
    if (Date.now() - this.lastMaintenanceAt < this.config.maintenanceMinIntervalMs) {
      return { processed: 0, upserted: 0, skippedBusy: true };
    }

    this.maintenanceRunning = true;
    let processed = 0;
    let upserted = 0;
    try {
      const ids = conversationId
        ? [conversationId]
        : this.store.listConversationIds().slice(0, 20);
      for (const id of ids) {
        if (globalTurnLock.isBusy()) break;
        const checkpoint = this.store.getMaintenanceCheckpoint(id);
        const turns = this.store.turnsAfter(
          id,
          checkpoint,
          this.config.maintenanceBatchTurns,
        );
        let maxId = checkpoint;
        for (const turn of turns) {
          processed++;
          maxId = Math.max(maxId, turn.id);
          for (const mem of extractMemoriesFromUserText(turn.content)) {
            const item = this.store.upsertMemory({
              conversationId: id,
              kind: mem.kind,
              content: mem.content,
              source: "deterministic-maintenance",
            });
            if (item) upserted++;
          }
        }
        if (maxId > checkpoint) {
          this.store.setMaintenanceCheckpoint(id, maxId);
        }
      }
      this.lastMaintenanceAt = Date.now();
      log.info("memory:maintenance", { processed, upserted });
      return { processed, upserted, skippedBusy: false };
    } finally {
      this.maintenanceRunning = false;
      this.scheduleIdleMaintenance();
    }
  }

  scheduleIdleMaintenance(): void {
    if (!this.config.enabled || this.closed) return;
    if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
    this.maintenanceTimer = setTimeout(() => {
      this.runMaintenance();
    }, this.config.maintenanceIdleMs + 500);
    this.maintenanceTimer.unref?.();
  }
}

let singleton: MemoryManager | undefined;

export function getMemoryManager(opts?: MemoryManagerOptions): MemoryManager {
  if (!singleton) {
    singleton = new MemoryManager(opts);
    singleton.scheduleIdleMaintenance();
  }
  return singleton;
}

/** Create/replace the process singleton (e.g. on agent start with config). */
export function configureMemoryManager(opts: MemoryManagerOptions = {}): MemoryManager {
  if (singleton) {
    try {
      singleton.close();
    } catch {
      // ignore
    }
  }
  singleton = new MemoryManager(opts);
  singleton.scheduleIdleMaintenance();
  return singleton;
}

/** Test helper — replace or clear the process singleton. */
export function resetMemoryManagerForTests(manager?: MemoryManager): void {
  if (singleton) {
    try {
      singleton.close();
    } catch {
      // ignore
    }
  }
  singleton = manager;
}
