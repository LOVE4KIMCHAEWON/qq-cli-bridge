import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTurnUsageRecord,
  parseUsagePayload,
  fingerprintId,
} from "../src/telemetry/usage.js";

describe("usage telemetry parsing", () => {
  it("parses usage_update context occupancy without inventing billed fields", () => {
    const parsed = parseUsagePayload({
      sessionUpdate: "usage_update",
      used: 53000,
      size: 200000,
      cost: { amount: 0.045, currency: "USD" },
    });
    assert.equal(parsed.contextUsed, 53000);
    assert.equal(parsed.contextSize, 200000);
    assert.deepEqual(parsed.cumulativeCost, { amount: 0.045, currency: "USD" });
    assert.equal(parsed.input, undefined);
    assert.equal(parsed.output, undefined);
    assert.equal(parsed.total, undefined);
  });

  it("parses end-turn usage strawman when present", () => {
    const parsed = parseUsagePayload({
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedReadTokens: 50,
        cachedWriteTokens: 10,
        thoughtTokens: 5,
        totalTokens: 135,
        modelRequestCount: 2,
      },
    });
    assert.equal(parsed.input, 100);
    assert.equal(parsed.output, 20);
    assert.equal(parsed.cacheRead, 50);
    assert.equal(parsed.cacheWrite, 10);
    assert.equal(parsed.thought, 5);
    assert.equal(parsed.total, 135);
    assert.equal(parsed.modelRequestCount, 2);
  });

  it("marks missing fields unavailable and never assumes 1 model request", () => {
    const record = buildTurnUsageRecord({
      turnId: "t1",
      backend: "Cursor Agent",
      transport: "acp",
      latencyMs: 1200,
    });
    assert.equal(record.modelRequestCount, "unavailable");
    assert.equal(record.tokens.input, "unavailable");
    assert.equal(record.tokens.output, "unavailable");
    assert.equal(record.tokens.total, "unavailable");
    assert.equal(record.tokens.contextUsed, "unavailable");
    assert.equal(record.modelId, "unavailable");
  });

  it("emits soft warnings for high context / growth", () => {
    const record = buildTurnUsageRecord({
      turnId: "t2",
      backend: "Cursor Agent (ACP)",
      transport: "acp",
      usageUpdates: [{ sessionUpdate: "usage_update", used: 250_000, size: 1_000_000 }],
      previousContextUsed: 100_000,
      thresholds: {
        contextUsedWarn: 200_000,
        contextGrowthWarn: 50_000,
        turnTotalWarn: 100_000,
      },
    });
    assert.ok(record.warnings.some((w) => w.includes("contextUsed=")));
    assert.ok(record.warnings.some((w) => w.includes("context grew")));
  });

  it("fingerprints ids without leaking raw values into short hash", () => {
    const a = fingerprintId("c2c:secret-openid");
    const b = fingerprintId("c2c:secret-openid");
    const c = fingerprintId("c2c:other");
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(a.length, 12);
    assert.equal(fingerprintId(undefined), "unavailable");
  });
});
