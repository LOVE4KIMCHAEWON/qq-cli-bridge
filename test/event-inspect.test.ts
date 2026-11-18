import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  contentCorrelationHash,
  describeC2cIdentityMapping,
  inspectInboundMessage,
} from "../src/qq/event-inspect.js";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";

function fakeMsg(overrides: Partial<QQBotInboundMessage> & { raw: Record<string, unknown> }): QQBotInboundMessage {
  const raw = overrides.raw;
  return {
    rawEventType: "C2C_MESSAGE_CREATE",
    kind: "c2c",
    senderId: "user-openid",
    content: "hi",
    messageId: String(raw.id),
    timestamp: String(raw.timestamp),
    msgIdx: "REFIDX_abc",
    replyTarget: { scope: "c2c", targetId: "user-openid" },
    raw: raw as QQBotInboundMessage["raw"],
    ...overrides,
  } as QQBotInboundMessage;
}

describe("event inspect — privacy + mapping", () => {
  it("hashes same normalized content identically and never embeds plaintext", () => {
    const a = contentCorrelationHash("hi");
    const b = contentCorrelationHash("hi");
    const c = contentCorrelationHash("hello");
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(a.length, 16);
    assert.doesNotMatch(a, /hi|hello/i);
  });

  it("reports idsEqual when normalization preserved raw.id", () => {
    const rawId = "ROBOT1.0_example_id!";
    const msg = fakeMsg({
      messageId: rawId,
      raw: {
        id: rawId,
        content: "SECRET_PLAINTEXT_SHOULD_NOT_APPEAR",
        timestamp: "2026-11-17T05:00:00Z",
        author: { user_openid: "user-openid" },
        message_scene: { ext: ["msg_idx=REFIDX_abc"] },
      },
    });
    const inspection = inspectInboundMessage(msg, "SECRET_PLAINTEXT_SHOULD_NOT_APPEAR", {
      conversationId: "c2c:user-openid",
      handlerId: "h1",
    });
    assert.equal(inspection.idsEqual, true);
    assert.equal(inspection.timestampsEqual, true);
    assert.deepEqual(inspection.rawExt, ["msg_idx=REFIDX_abc"]);
    const json = JSON.stringify(inspection);
    assert.doesNotMatch(json, /SECRET_PLAINTEXT/);
    assert.match(json, /contentHash/);
  });

  it("documents the C2C identity mapping contract", () => {
    const doc = describeC2cIdentityMapping();
    assert.match(doc, /raw\.d\.id/);
    assert.match(doc, /messageId/);
    assert.match(doc, /seq/);
  });
});
