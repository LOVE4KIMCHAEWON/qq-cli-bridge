import { randomUUID } from "node:crypto";
import { log } from "../util/logger.js";

/**
 * Per-inbound-message pipeline instrumentation.
 * Never logs message content or secrets.
 */
export interface PipelineCounters {
  handlerInvocations: number;
  dedupeClaimed: number;
  dedupeDuplicate: number;
  agentTurns: number;
  agentSpawns: number;
  finalOutputEvents: number;
  qqOutboundAttempts: number;
  qqOutboundSuccess: number;
  qqOutboundSkipped: number;
}

export class PipelineTrace {
  readonly handlerId: string;
  readonly startedAt = Date.now();
  messageId?: string;
  conversationId?: string;
  rawEventType?: string;
  msgIdx?: string;
  contentHash?: string;
  rawTimestamp?: string;
  idsEqual?: boolean;
  dedupeResult?: string;
  dedupeHitKey?: string;
  agentSessionId?: string;
  turnId?: string;
  spawns = 0;
  finalOutputs = 0;
  outboundAttempts = 0;
  outboundSuccess = 0;
  outboundSkipped = 0;
  private closed = false;

  constructor() {
    this.handlerId = randomUUID();
  }

  static globalCounters: PipelineCounters = {
    handlerInvocations: 0,
    dedupeClaimed: 0,
    dedupeDuplicate: 0,
    agentTurns: 0,
    agentSpawns: 0,
    finalOutputEvents: 0,
    qqOutboundAttempts: 0,
    qqOutboundSuccess: 0,
    qqOutboundSkipped: 0,
  };

  static resetCounters(): void {
    PipelineTrace.globalCounters = {
      handlerInvocations: 0,
      dedupeClaimed: 0,
      dedupeDuplicate: 0,
      agentTurns: 0,
      agentSpawns: 0,
      finalOutputEvents: 0,
      qqOutboundAttempts: 0,
      qqOutboundSuccess: 0,
      qqOutboundSkipped: 0,
    };
  }

  markInbound(meta: {
    rawEventType?: string;
    messageId?: string;
    conversationId?: string;
    msgIdx?: string;
    contentHash?: string;
    rawTimestamp?: string;
    idsEqual?: boolean;
  }): void {
    this.rawEventType = meta.rawEventType;
    this.messageId = meta.messageId;
    this.conversationId = meta.conversationId;
    this.msgIdx = meta.msgIdx;
    this.contentHash = meta.contentHash;
    this.rawTimestamp = meta.rawTimestamp;
    this.idsEqual = meta.idsEqual;
    PipelineTrace.globalCounters.handlerInvocations += 1;
    this.emit("inbound_received");
  }

  markDedupe(result: "claimed" | "duplicate", hitKey?: string): void {
    this.dedupeResult = result;
    this.dedupeHitKey = hitKey;
    if (result === "claimed") PipelineTrace.globalCounters.dedupeClaimed += 1;
    else PipelineTrace.globalCounters.dedupeDuplicate += 1;
    this.emit("dedupe");
  }

  beginTurn(sessionId: string | undefined): string {
    this.turnId = randomUUID();
    this.agentSessionId = sessionId;
    PipelineTrace.globalCounters.agentTurns += 1;
    this.emit("agent_turn_begin");
    return this.turnId;
  }

  markSpawn(): void {
    this.spawns += 1;
    PipelineTrace.globalCounters.agentSpawns += 1;
    this.emit("agent_spawn");
  }

  markFinalOutput(): void {
    this.finalOutputs += 1;
    PipelineTrace.globalCounters.finalOutputEvents += 1;
    this.emit("final_output");
  }

  markOutbound(result: "success" | "skipped" | "error"): void {
    this.outboundAttempts += 1;
    PipelineTrace.globalCounters.qqOutboundAttempts += 1;
    if (result === "success") {
      this.outboundSuccess += 1;
      PipelineTrace.globalCounters.qqOutboundSuccess += 1;
    } else if (result === "skipped") {
      this.outboundSkipped += 1;
      PipelineTrace.globalCounters.qqOutboundSkipped += 1;
    }
    this.emit("qq_outbound", { result });
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("pipeline_close", { reason, elapsedMs: Date.now() - this.startedAt });
  }

  snapshot() {
    return {
      handlerId: this.handlerId,
      rawEventType: this.rawEventType,
      messageId: this.messageId,
      conversationId: this.conversationId,
      msgIdx: this.msgIdx,
      contentHash: this.contentHash,
      rawTimestamp: this.rawTimestamp,
      idsEqual: this.idsEqual,
      dedupeResult: this.dedupeResult,
      dedupeHitKey: this.dedupeHitKey,
      agentSessionId: this.agentSessionId,
      turnId: this.turnId,
      spawns: this.spawns,
      finalOutputs: this.finalOutputs,
      outboundAttempts: this.outboundAttempts,
      outboundSuccess: this.outboundSuccess,
      outboundSkipped: this.outboundSkipped,
    };
  }

  private emit(phase: string, extra?: Record<string, unknown>): void {
    const payload = { ...this.snapshot(), ...extra };
    log.info(`pipeline:${phase}`, payload);
    // Surface high-signal phases on the console (never includes message content).
    if (
      phase === "dedupe" ||
      phase === "agent_spawn" ||
      phase === "qq_outbound" ||
      phase === "pipeline_close"
    ) {
      console.log(`[qqbridge:pipeline] ${phase}`, JSON.stringify(payload));
    }
  }
}

/** Ensures at most one QQ final reply is sent for a turn. */
export class TurnReplyGate {
  private sent = false;
  private finalCount = 0;

  noteFinal(): number {
    this.finalCount += 1;
    return this.finalCount;
  }

  /** Returns true if this call wins the right to send. */
  trySend(): boolean {
    if (this.sent) return false;
    this.sent = true;
    return true;
  }

  get finals(): number {
    return this.finalCount;
  }

  get didSend(): boolean {
    return this.sent;
  }
}
