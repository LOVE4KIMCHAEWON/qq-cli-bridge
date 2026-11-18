import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAdapter } from "../src/adapters/registry.js";
import { defaultConfig } from "../src/config/store.js";
import { GeminiAcpAdapter } from "../src/adapters/gemini-acp.js";

describe("Gemini registry transport selection", () => {
  it("defaults to oneshot GeminiAdapter", () => {
    const cfg = defaultConfig();
    const adapter = createAdapter("gemini", cfg);
    assert.equal(adapter.displayName, "Gemini CLI");
  });

  it("selects ACP adapter when transport=acp", () => {
    const cfg = defaultConfig();
    cfg.agents.gemini.transport = "acp";
    const adapter = createAdapter("gemini", cfg);
    assert.ok(adapter instanceof GeminiAcpAdapter);
    assert.equal(adapter.displayName, "Gemini CLI (ACP)");
  });
});
