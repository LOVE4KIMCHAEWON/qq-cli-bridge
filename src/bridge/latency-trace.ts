import { log } from "../util/logger.js";

/**
 * Per-turn latency marks (no message content).
 * Cold ACP init is logged separately from warm per-message latency.
 */
export class LatencyTrace {
  readonly marks = new Map<string, number>();
  constructor(readonly label: string) {
    this.mark("created");
  }

  mark(name: string): void {
    this.marks.set(name, Date.now());
  }

  msSince(name: string): number | undefined {
    const t = this.marks.get(name);
    if (t == null) return undefined;
    return Date.now() - t;
  }

  delta(from: string, to: string): number | undefined {
    const a = this.marks.get(from);
    const b = this.marks.get(to);
    if (a == null || b == null) return undefined;
    return b - a;
  }

  summarize(extra: Record<string, unknown> = {}): void {
    const inbound = this.marks.get("qq_inbound");
    const queued = this.marks.get("queue_enter");
    const prompt = this.marks.get("prompt_sent");
    const first = this.marks.get("first_text");
    const finalMark = this.marks.get("final_result");
    const outbound = this.marks.get("qq_outbound");
    log.info("latency:turn", {
      label: this.label,
      queueWaitMs:
        inbound != null && queued != null ? queued - inbound : undefined,
      promptFromQueueMs:
        queued != null && prompt != null ? prompt - queued : undefined,
      firstTextMs:
        prompt != null && first != null ? first - prompt : undefined,
      finalMs:
        prompt != null && finalMark != null ? finalMark - prompt : undefined,
      outboundFromFinalMs:
        finalMark != null && outbound != null ? outbound - finalMark : undefined,
      endToEndMs:
        inbound != null && outbound != null ? outbound - inbound : undefined,
      acpInitMs: this.delta("acp_init_start", "acp_init_done"),
      ...extra,
    });
  }
}
