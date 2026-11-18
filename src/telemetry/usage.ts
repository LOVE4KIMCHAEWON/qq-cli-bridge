import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { dataRoot, ensureDataDirs } from "../paths.js";
import { log } from "../util/logger.js";

/**
 * Privacy-conscious per-turn usage record.
 * Never includes prompts, replies, credentials, or tool payloads.
 */
export interface TurnUsageRecord {
  v: 1;
  turnId: string;
  at: string;
  backend: string;
  transport: "oneshot" | "acp" | "unknown";
  /** Effective model id when known; otherwise unavailable. */
  modelId: string | "unavailable";
  /** Redacted session fingerprint — not the raw session id. */
  sessionFingerprint: string | "unavailable";
  conversationFingerprint: string | "unavailable";
  latencyMs: number | "unavailable";
  /**
   * Underlying model request count when known.
   * Explicitly "unavailable" — never assume 1 agent turn == 1 model request.
   */
  modelRequestCount: number | "unavailable";
  tokens: {
    /** Provider input tokens for this turn, if exposed. */
    input: number | "unavailable";
    output: number | "unavailable";
    cacheRead: number | "unavailable";
    cacheWrite: number | "unavailable";
    thought: number | "unavailable";
    /** Sum of billed-ish fields when available; else unavailable. */
    total: number | "unavailable";
    /**
     * ACP usage_update context window occupancy (includes cached context).
     * Not the same as billed turn tokens.
     */
    contextUsed: number | "unavailable";
    contextSize: number | "unavailable";
  };
  /** Cumulative session cost if ACP reports it. */
  cumulativeCost: { amount: number; currency: string } | "unavailable";
  warnings: string[];
}

export interface UsageWarningThresholds {
  /** Warn when contextUsed exceeds this (session context window occupancy). */
  contextUsedWarn?: number;
  /** Warn when reported turn total tokens exceed this. */
  turnTotalWarn?: number;
  /** Warn when contextUsed grows by more than this vs previous turn in same session. */
  contextGrowthWarn?: number;
}

const DEFAULT_THRESHOLDS: Required<UsageWarningThresholds> = {
  contextUsedWarn: 200_000,
  turnTotalWarn: 100_000,
  contextGrowthWarn: 50_000,
};

function usageLogPath(): string {
  return path.join(dataRoot(), "logs", "usage.jsonl");
}

export function fingerprintId(raw: string | undefined): string | "unavailable" {
  if (!raw) return "unavailable";
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/** Parse ACP/provider usage payloads without inventing fields. */
export function parseUsagePayload(raw: unknown): {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  thought?: number;
  total?: number;
  contextUsed?: number;
  contextSize?: number;
  cumulativeCost?: { amount: number; currency: string };
  modelRequestCount?: number;
} {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;

  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  // usage_update shape
  const contextUsed = num(o.used);
  const contextSize = num(o.size);
  let cumulativeCost: { amount: number; currency: string } | undefined;
  if (o.cost && typeof o.cost === "object") {
    const c = o.cost as Record<string, unknown>;
    if (typeof c.amount === "number" && typeof c.currency === "string") {
      cumulativeCost = { amount: c.amount, currency: c.currency };
    }
  }

  // end-turn usage strawman / provider meta
  const usageObj =
    o.usage && typeof o.usage === "object"
      ? (o.usage as Record<string, unknown>)
      : o;

  const input = num(usageObj.inputTokens) ?? num(usageObj.input);
  const output = num(usageObj.outputTokens) ?? num(usageObj.output);
  const cacheRead =
    num(usageObj.cachedReadTokens) ??
    num(usageObj.cacheReadTokens) ??
    num(usageObj.cache_read_input_tokens);
  const cacheWrite =
    num(usageObj.cachedWriteTokens) ??
    num(usageObj.cacheWriteTokens) ??
    num(usageObj.cache_creation_input_tokens);
  const thought = num(usageObj.thoughtTokens) ?? num(usageObj.reasoningTokens);
  const total =
    num(usageObj.totalTokens) ??
    num(usageObj.total) ??
    (input != null || output != null
      ? (input ?? 0) +
        (output ?? 0) +
        (thought ?? 0) +
        (cacheWrite ?? 0)
      : undefined);

  const modelRequestCount =
    num(usageObj.modelRequestCount) ??
    num(usageObj.requestCount) ??
    num(o.modelRequestCount);

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    thought,
    total,
    contextUsed,
    contextSize,
    cumulativeCost,
    modelRequestCount,
  };
}

export function buildTurnUsageRecord(input: {
  turnId: string;
  backend: string;
  transport: TurnUsageRecord["transport"];
  modelId?: string;
  sessionId?: string;
  conversationId?: string;
  latencyMs?: number;
  usageRaw?: unknown;
  usageUpdates?: unknown[];
  thresholds?: UsageWarningThresholds;
  previousContextUsed?: number;
}): TurnUsageRecord {
  const thr = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const merged: Record<string, unknown> = {};
  for (const u of input.usageUpdates ?? []) {
    if (u && typeof u === "object") Object.assign(merged, u);
  }
  if (input.usageRaw && typeof input.usageRaw === "object") {
    Object.assign(merged, input.usageRaw);
  }
  const parsed = parseUsagePayload(merged);

  const orUnavail = (v: number | undefined): number | "unavailable" =>
    v == null ? "unavailable" : v;

  const warnings: string[] = [];
  if (
    typeof parsed.contextUsed === "number" &&
    parsed.contextUsed >= thr.contextUsedWarn
  ) {
    warnings.push(
      `contextUsed=${parsed.contextUsed} exceeds warn threshold ${thr.contextUsedWarn} (context occupancy, may include cache)`,
    );
  }
  if (typeof parsed.total === "number" && parsed.total >= thr.turnTotalWarn) {
    warnings.push(
      `turn totalTokens=${parsed.total} exceeds warn threshold ${thr.turnTotalWarn}`,
    );
  }
  if (
    typeof parsed.contextUsed === "number" &&
    typeof input.previousContextUsed === "number" &&
    parsed.contextUsed - input.previousContextUsed >= thr.contextGrowthWarn
  ) {
    warnings.push(
      `context grew by ${parsed.contextUsed - input.previousContextUsed} tokens since prior turn (threshold ${thr.contextGrowthWarn})`,
    );
  }

  const record: TurnUsageRecord = {
    v: 1,
    turnId: input.turnId,
    at: new Date().toISOString(),
    backend: input.backend,
    transport: input.transport,
    modelId: input.modelId ?? "unavailable",
    sessionFingerprint: fingerprintId(input.sessionId),
    conversationFingerprint: fingerprintId(input.conversationId),
    latencyMs: input.latencyMs ?? "unavailable",
    modelRequestCount: parsed.modelRequestCount ?? "unavailable",
    tokens: {
      input: orUnavail(parsed.input),
      output: orUnavail(parsed.output),
      cacheRead: orUnavail(parsed.cacheRead),
      cacheWrite: orUnavail(parsed.cacheWrite),
      thought: orUnavail(parsed.thought),
      total: orUnavail(parsed.total),
      contextUsed: orUnavail(parsed.contextUsed),
      contextSize: orUnavail(parsed.contextSize),
    },
    cumulativeCost: parsed.cumulativeCost ?? "unavailable",
    warnings,
  };
  return record;
}

export function recordTurnUsage(record: TurnUsageRecord): void {
  ensureDataDirs();
  for (const w of record.warnings) {
    log.warn("usage:warning", {
      turnId: record.turnId,
      warning: w,
      transport: record.transport,
      modelId: record.modelId,
    });
  }
  log.info("usage:turn", {
    turnId: record.turnId,
    backend: record.backend,
    transport: record.transport,
    modelId: record.modelId,
    sessionFingerprint: record.sessionFingerprint,
    conversationFingerprint: record.conversationFingerprint,
    latencyMs: record.latencyMs,
    modelRequestCount: record.modelRequestCount,
    tokens: record.tokens,
    cumulativeCost: record.cumulativeCost,
    warningCount: record.warnings.length,
  });
  try {
    fs.appendFileSync(usageLogPath(), JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    log.warn("usage:write_failed", { message: (err as Error).message });
  }
}
