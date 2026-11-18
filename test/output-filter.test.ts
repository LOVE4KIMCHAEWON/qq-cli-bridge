import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractJsonFinalText, sanitizeForQq } from "../src/util/output-filter.js";
import { parseApprovalMessage, looksDangerous } from "../src/security/approval.js";

describe("sanitizeForQq", () => {
  it("strips ansi and secrets", () => {
    const input = "\u001b[32mHello\u001b[0m\nAuthorization: Bearer SECRET123\nOK";
    const out = sanitizeForQq(input);
    assert.match(out, /Hello/);
    assert.match(out, /OK/);
    assert.doesNotMatch(out, /SECRET123/);
  });
});

describe("extractJsonFinalText", () => {
  it("reads result field", () => {
    assert.equal(extractJsonFinalText(JSON.stringify({ result: "hi there" })), "hi there");
  });

  it("reads ndjson last result", () => {
    const nd = [
      JSON.stringify({ type: "status", text: "working" }),
      JSON.stringify({ type: "result", result: "done" }),
    ].join("\n");
    assert.equal(extractJsonFinalText(nd), "done");
  });
});

describe("approval gate", () => {
  it("only exact phrases approve", () => {
    assert.equal(parseApprovalMessage("/approve once"), "approve_once");
    assert.equal(parseApprovalMessage("sure go ahead"), "not_approval");
    assert.equal(parseApprovalMessage("/deny"), "deny");
  });

  it("detects dangerous hints", () => {
    assert.equal(looksDangerous("please rm -rf /"), true);
    assert.equal(looksDangerous("explain this file"), false);
  });
});
