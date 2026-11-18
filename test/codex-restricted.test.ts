import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_QQ_DISABLED_FEATURES,
  CODEX_RESTRICTED_POLICY_VERSION,
  codexRestrictedCliFlags,
  ensureCodexQqHome,
  verifyCodexRestrictedStatic,
  verifyCodexRestrictedExecution,
  assertCodexRestrictedReadyForQq,
} from "../src/security/codex-restricted.js";
import { isQqChatBackendAllowed } from "../src/security/chat-only.js";
import { assembleBridgeContext } from "../src/context/assemble.js";

function writeMarker(): void {
  const p = path.join(process.env.QQBRIDGE_DATA_DIR!, "state", "codex-restricted-verify.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({
      ok: true,
      at: new Date().toISOString(),
      policyVersion: CODEX_RESTRICTED_POLICY_VERSION,
    }),
    "utf8",
  );
}

describe("Codex restricted — static isolation", () => {
  let prev: string | undefined;
  let dataDir: string;

  beforeEach(() => {
    prev = process.env.QQBRIDGE_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-codex-r-"));
    process.env.QQBRIDGE_DATA_DIR = dataDir;
    // Fake auth so static checks pass without real login.
    const home = ensureCodexQqHome({ model: "gpt-test" });
    fs.writeFileSync(home.authPath, JSON.stringify({ test: true }), "utf8");
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.QQBRIDGE_DATA_DIR;
    else process.env.QQBRIDGE_DATA_DIR = prev;
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows locks
    }
  });

  it("writes isolated config without mcp/plugins and with required disables", () => {
    const r = verifyCodexRestrictedStatic({ model: "gpt-test" });
    assert.equal(r.ok, true, r.errors.join("; "));
    const cfg = fs.readFileSync(r.home.configPath, "utf8");
    assert.match(cfg, /web_search\s*=\s*"live"/);
    assert.match(cfg, /sandbox_mode\s*=\s*"read-only"/);
    assert.match(cfg, /shell_tool\s*=\s*false/);
    assert.match(cfg, /computer_use\s*=\s*false/);
    assert.match(cfg, /plugins\s*=\s*false/);
    assert.match(cfg, /code_mode_host\s*=\s*true/);
    assert.doesNotMatch(cfg, /code_mode_host\s*=\s*false/);
    assert.doesNotMatch(cfg, /\[mcp_servers\]/);
  });

  it("CLI flags include disables and read-only sandbox", () => {
    const flags = codexRestrictedCliFlags({ webSearch: "live" });
    assert.ok(flags.includes("--disable"));
    assert.ok(flags.includes("shell_tool"));
    assert.ok(flags.includes("-s"));
    assert.ok(flags.includes("read-only"));
    assert.ok(flags.includes("--enable"));
    assert.ok(flags.includes("code_mode_host"));
    for (const f of ["shell_tool", "browser_use", "computer_use", "plugins"] as const) {
      assert.ok(CODEX_QQ_DISABLED_FEATURES.includes(f));
    }
  });

  it("assertCodexRestrictedReadyForQq fails without verify marker", () => {
    assert.throws(() => assertCodexRestrictedReadyForQq(), /verify marker/i);
  });

  it("assertCodexRestrictedReadyForQq passes with fresh marker", () => {
    writeMarker();
    const home = assertCodexRestrictedReadyForQq();
    assert.ok(home.homeDir.includes("codex-qq-home"));
  });

  it("QQ allowlist includes codex (gated further by transport+verify)", () => {
    assert.equal(isQqChatBackendAllowed("codex"), true);
    assert.equal(isQqChatBackendAllowed("claude"), true);
    assert.equal(isQqChatBackendAllowed("agent"), false);
  });

  it("shared context assembly stays backend-neutral for Codex developerInstructions", () => {
    const a = assembleBridgeContext({
      personaBody: "Be brief",
      memorySection: "--- Long-term Memory ---\n- note\n",
      cultureSection: "--- Culture KB ---\n- 破防\n",
    });
    assert.deepEqual(a.sections, ["persona", "memory", "culture"]);
    assert.match(a.fullText, /Persona/);
    assert.match(a.fullText, /Memory/);
    assert.match(a.fullText, /Culture/);
  });
});

describe("Codex restricted — execution probes (optional live)", () => {
  it("runs live probes when QQBRIDGE_CODEX_LIVE_VERIFY=1", async () => {
    if (process.env.QQBRIDGE_CODEX_LIVE_VERIFY !== "1") {
      // Keep default suite offline/fast; CI can opt in.
      return;
    }
    const result = await verifyCodexRestrictedExecution({ timeoutMs: 120_000 });
    assert.equal(result.ok, true, result.errors.join("\n") + "\n" + result.details.join("\n"));
  });
});
