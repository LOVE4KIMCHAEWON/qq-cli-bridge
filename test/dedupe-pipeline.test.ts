import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MessageDeduper } from "../src/bridge/message-dedupe.js";
import { PipelineTrace, TurnReplyGate } from "../src/bridge/pipeline-trace.js";

describe("MessageDeduper — QQ message identity", () => {
  let deduper: MessageDeduper;

  beforeEach(() => {
    deduper = new MessageDeduper({ windowMs: 60_000 });
  });

  it("drops duplicate delivery of the same QQ message ID", () => {
    const identity = {
      messageId: "msg-001",
      conversationId: "c2c:user-a",
      timestamp: "2026-11-17T05:00:00Z",
    };
    assert.equal(deduper.tryClaim(identity).result, "claimed");
    assert.equal(deduper.tryClaim(identity).result, "duplicate");
    assert.equal(deduper.tryClaim(identity).hitKey, "mid:msg-001");
  });

  it("treats two simultaneous handlers on the same event as one claim", () => {
    const identity = {
      messageId: "msg-concurrent",
      conversationId: "c2c:user-a",
      timestamp: "t1",
    };
    // Simulate two handlers entering without await between claims.
    const a = deduper.tryClaim(identity);
    const b = deduper.tryClaim(identity);
    assert.equal(a.result, "claimed");
    assert.equal(b.result, "duplicate");
  });

  it("allows two different QQ messages with identical text (different ids)", () => {
    const base = {
      conversationId: "c2c:user-a",
      // Different platform timestamps — intentional separate user sends.
    };
    const first = deduper.tryClaim({
      ...base,
      messageId: "msg-hi-1",
      timestamp: "2026-11-17T05:01:00.000Z",
    });
    const second = deduper.tryClaim({
      ...base,
      messageId: "msg-hi-2",
      timestamp: "2026-11-17T05:01:05.000Z",
    });
    assert.equal(first.result, "claimed");
    assert.equal(second.result, "claimed");
  });

  it("dedupes platform retries that reuse timestamp with a new message id", () => {
    const conv = "c2c:user-a";
    const ts = "2026-11-17T05:02:00.123Z";
    const first = deduper.tryClaim({
      messageId: "id-retry-1",
      conversationId: conv,
      timestamp: ts,
    });
    const second = deduper.tryClaim({
      messageId: "id-retry-2",
      conversationId: conv,
      timestamp: ts,
    });
    assert.equal(first.result, "claimed");
    assert.equal(second.result, "duplicate");
    assert.equal(second.hitKey, `ts:${conv}:${ts}`);
  });
});

describe("TurnReplyGate — one outbound per turn", () => {
  it("allows only one send even when two finals arrive", () => {
    const gate = new TurnReplyGate();
    assert.equal(gate.noteFinal(), 1);
    assert.equal(gate.noteFinal(), 2);
    assert.equal(gate.trySend(), true);
    assert.equal(gate.trySend(), false);
    assert.equal(gate.finals, 2);
    assert.equal(gate.didSend, true);
  });
});

describe("PipelineTrace counters", () => {
  beforeEach(() => {
    PipelineTrace.resetCounters();
  });

  it("counts handler / dedupe / spawn / final / outbound without content", () => {
    const t1 = new PipelineTrace();
    t1.markInbound({
      rawEventType: "C2C_MESSAGE_CREATE",
      messageId: "m1",
      conversationId: "c2c:u",
    });
    t1.markDedupe("claimed");
    t1.beginTurn("sess");
    t1.markSpawn();
    t1.markFinalOutput();
    t1.markOutbound("success");
    t1.close("done");

    const t2 = new PipelineTrace();
    t2.markInbound({
      rawEventType: "C2C_MESSAGE_CREATE",
      messageId: "m1",
      conversationId: "c2c:u",
    });
    t2.markDedupe("duplicate", "mid:m1");
    t2.close("deduped");

    const c = PipelineTrace.globalCounters;
    assert.equal(c.handlerInvocations, 2);
    assert.equal(c.dedupeClaimed, 1);
    assert.equal(c.dedupeDuplicate, 1);
    assert.equal(c.agentTurns, 1);
    assert.equal(c.agentSpawns, 1);
    assert.equal(c.finalOutputEvents, 1);
    assert.equal(c.qqOutboundSuccess, 1);

    // Snapshot must not include a content field
    const snap = JSON.stringify(t1.snapshot());
    assert.doesNotMatch(snap, /content|text|prompt/i);
  });
});

describe("simulated dual-handler pipeline", () => {
  it("one agent turn and one outbound for duplicate message id deliveries", async () => {
    PipelineTrace.resetCounters();
    const deduper = new MessageDeduper();
    let spawns = 0;
    let outbounds = 0;

    async function handle(messageId: string, timestamp: string) {
      const trace = new PipelineTrace();
      const conversationId = "c2c:user";
      trace.markInbound({
        rawEventType: "C2C_MESSAGE_CREATE",
        messageId,
        conversationId,
      });
      const claim = deduper.tryClaim({ messageId, conversationId, timestamp });
      trace.markDedupe(claim.result, claim.hitKey);
      if (claim.result === "duplicate") {
        trace.close("deduped");
        return;
      }
      trace.beginTurn("sess");
      spawns += 1;
      trace.markSpawn();
      const gate = new TurnReplyGate();
      gate.noteFinal();
      gate.noteFinal(); // two finals from one turn
      trace.markFinalOutput();
      trace.markFinalOutput();
      if (gate.trySend()) {
        outbounds += 1;
        trace.markOutbound("success");
      } else {
        trace.markOutbound("skipped");
      }
      if (gate.trySend()) {
        outbounds += 1;
        trace.markOutbound("success");
      } else {
        trace.markOutbound("skipped");
      }
      trace.close("done");
    }

    // Concurrent dual delivery — same id (and same timestamp)
    await Promise.all([
      handle("dup-id", "ts-same"),
      handle("dup-id", "ts-same"),
    ]);

    assert.equal(spawns, 1);
    assert.equal(outbounds, 1);
    assert.equal(PipelineTrace.globalCounters.dedupeDuplicate, 1);
    assert.equal(PipelineTrace.globalCounters.agentSpawns, 1);
    assert.equal(PipelineTrace.globalCounters.qqOutboundSuccess, 1);
    assert.equal(PipelineTrace.globalCounters.qqOutboundSkipped, 1);
  });
});
