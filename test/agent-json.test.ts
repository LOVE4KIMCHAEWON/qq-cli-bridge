import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractJsonFinalText } from "../src/util/output-filter.js";

describe("agent CLI json shape", () => {
  it("extracts result and tolerates session_id sibling", () => {
    const sample = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "PONG",
      session_id: "e944b3b0-1e4c-446b-b9cc-75a73f82b311",
    });
    assert.equal(extractJsonFinalText(sample), "PONG");
  });
});
