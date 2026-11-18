import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeGroupAccessPolicy,
  formatGroupAccessBlockHint,
  shouldBlockForEmptyC2cAllowlist,
} from "../src/qq/access.js";
import { defaultConfig, saveConfig } from "../src/config/store.js";
import { BridgeRuntime, resetRuntimeForTests } from "../src/bridge/runtime.js";
import type { AgentAdapter, AgentTurnHooks, AgentTurnOptions } from "../src/types.js";
import type { ModelCatalog, ModelSwitchResult } from "../src/models/types.js";
import type { ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { PipelineTrace } from "../src/bridge/pipeline-trace.js";
import { MemoryManager, resetMemoryManagerForTests } from "../src/memory/manager.js";
import {
  CultureManager,
  resetCultureManagerForTests,
} from "../src/culture/manager.js";
import { MemoryStore } from "../src/memory/store.js";

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-group-"));
}

describe("Group access policy helpers", () => {
  it("does not treat empty C2C allowlist as a group block", () => {
    const cfg = defaultConfig();
    cfg.allowlist.c2cMode = "allowlist";
    cfg.allowlist.users = [];
    cfg.allowlist.groupMode = "allowlist";
    cfg.allowlist.groups = ["group-1"];
    assert.equal(shouldBlockForEmptyC2cAllowlist(cfg, "c2c"), true);
    assert.equal(shouldBlockForEmptyC2cAllowlist(cfg, "group"), false);
  });

  it("warns when group allowlist is empty under allowlist mode", () => {
    const cfg = defaultConfig();
    cfg.allowlist.groupMode = "allowlist";
    cfg.allowlist.groups = [];
    const d = describeGroupAccessPolicy(cfg);
    assert.equal(d.willReceiveGroupAt, false);
    assert.match(d.startupWarning ?? "", /add-group/);
  });

  it("allows group traffic when group is listed", () => {
    const cfg = defaultConfig();
    cfg.allowlist.groupMode = "allowlist";
    cfg.allowlist.groups = ["G1"];
    const d = describeGroupAccessPolicy(cfg);
    assert.equal(d.willReceiveGroupAt, true);
    assert.equal(d.startupWarning, undefined);
  });

  it("formats block hint with add-group command", () => {
    const hint = formatGroupAccessBlockHint("ABC123", "allowlist is empty");
    assert.match(hint, /allowlist add-group ABC123/);
  });
});

class CaptureAdapter implements AgentAdapter {
  readonly kind = "claude" as const;
  readonly displayName = "Capture";
  readonly supportsSessionResume = true;
  sent: Array<{ text: string; conversationId?: string }> = [];

  onOutput(): void {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getSessionId(): string | undefined {
    return "sess-g";
  }
  async send(): Promise<void> {}
  async sendAndCollect(
    message: string,
    _sessionId: string,
    hooks?: AgentTurnHooks,
    turn?: AgentTurnOptions,
  ): Promise<string> {
    hooks?.onSpawn?.();
    this.sent.push({ text: message, conversationId: turn?.conversationId });
    hooks?.onFinal?.();
    return `echo:${message}`;
  }
  async listModels(): Promise<ModelCatalog> {
    return { backend: "Capture", discovery: "unsupported", models: [] };
  }
  async resolveModelSwitch(): Promise<ModelSwitchResult> {
    return { ok: true, effectiveModelId: undefined, message: "ok" };
  }
}

describe("Runtime — group vs C2C allowlist separation", () => {
  let dataDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dataDir = tempDataDir();
    prev = process.env.QQBRIDGE_DATA_DIR;
    process.env.QQBRIDGE_DATA_DIR = dataDir;
    resetRuntimeForTests();
    resetMemoryManagerForTests(
      new MemoryManager({
        store: new MemoryStore({ dbPath: ":memory:" }),
        config: { enabled: true, maintenanceIdleMs: 60_000 },
      }),
    );
    resetCultureManagerForTests(
      new CultureManager({ dbPath: ":memory:", skipSeed: true, config: { enabled: true } }),
    );
  });

  afterEach(() => {
    resetRuntimeForTests();
    resetMemoryManagerForTests(undefined);
    resetCultureManagerForTests(undefined);
    if (prev === undefined) delete process.env.QQBRIDGE_DATA_DIR;
    else process.env.QQBRIDGE_DATA_DIR = prev;
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows may briefly lock emptied temp dirs.
    }
  });

  it("processes group @ text even when C2C user allowlist is empty", async () => {
    const cfg = defaultConfig();
    cfg.allowlist.c2cMode = "allowlist";
    cfg.allowlist.users = [];
    cfg.allowlist.groupMode = "allowlist";
    cfg.allowlist.groups = ["group-openid-1"];
    cfg.bridge.requireApprovalForDangerous = false;
    saveConfig(cfg);

    const runtime = new BridgeRuntime();
    const adapter = new CaptureAdapter();
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;

    const outbound: string[] = [];
    (runtime as unknown as { transport: Record<string, unknown> }).transport = {
      sendText: async (_t: ReplyTarget, text: string) => {
        outbound.push(text);
        return true;
      },
      sendTyping: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined,
    };

    const groupTarget: ReplyTarget = {
      scope: "group",
      targetId: "group-openid-1",
      msgId: "gm-1",
    };
    await runtime.handleQqMessage(
      "你好群聊",
      groupTarget,
      "member-openid",
      new PipelineTrace(),
      "group:group-openid-1",
    );

    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0]?.text, "你好群聊");
    assert.equal(adapter.sent[0]?.conversationId, "group:group-openid-1");
    assert.ok(outbound.some((t) => t.includes("echo:你好群聊")));
    // Must not get the C2C "not allowlisted" denial.
    assert.equal(outbound.some((t) => /not allowlisted/i.test(t)), false);
    await runtime.stop();
  });

  it("still denies empty C2C allowlist for private chat only", async () => {
    const cfg = defaultConfig();
    cfg.allowlist.c2cMode = "allowlist";
    cfg.allowlist.users = [];
    saveConfig(cfg);

    const runtime = new BridgeRuntime();
    const adapter = new CaptureAdapter();
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;
    const outbound: string[] = [];
    (runtime as unknown as { transport: Record<string, unknown> }).transport = {
      sendText: async (_t: ReplyTarget, text: string) => {
        outbound.push(text);
        return true;
      },
      sendTyping: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined,
    };

    await runtime.handleQqMessage(
      "hi",
      { scope: "c2c", targetId: "user-1", msgId: "c1" },
      "user-1",
      new PipelineTrace(),
      "c2c:user-1",
    );

    assert.equal(adapter.sent.length, 0);
    assert.match(outbound.join("\n"), /allowlist add/i);
    await runtime.stop();
  });

  it("slash commands cannot bypass empty C2C allowlist", async () => {
    const cfg = defaultConfig();
    cfg.allowlist.c2cMode = "allowlist";
    cfg.allowlist.users = [];
    saveConfig(cfg);

    const runtime = new BridgeRuntime();
    const adapter = new CaptureAdapter();
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;
    const outbound: string[] = [];
    (runtime as unknown as { transport: Record<string, unknown> }).transport = {
      sendText: async (_t: ReplyTarget, text: string) => {
        outbound.push(text);
        return true;
      },
      sendTyping: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined,
    };

    await runtime.handleQqMessage(
      "/model",
      { scope: "c2c", targetId: "user-1", msgId: "c2" },
      "user-1",
      new PipelineTrace(),
      "c2c:user-1",
    );

    assert.equal(adapter.sent.length, 0);
    assert.match(outbound.join("\n"), /allowlist add/i);
    assert.doesNotMatch(outbound.join("\n"), /Backend:/);
    await runtime.stop();
  });

  it("group @bot /model is Bridge-local and keeps group conversation scope", async () => {
    const cfg = defaultConfig();
    cfg.allowlist.c2cMode = "allowlist";
    cfg.allowlist.users = [];
    cfg.allowlist.groupMode = "allowlist";
    cfg.allowlist.groups = ["group-openid-1"];
    cfg.bridge.requireApprovalForDangerous = false;
    saveConfig(cfg);

    const runtime = new BridgeRuntime();
    const adapter = new CaptureAdapter();
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;
    const outbound: { target: ReplyTarget; text: string }[] = [];
    (runtime as unknown as { transport: Record<string, unknown> }).transport = {
      sendText: async (t: ReplyTarget, text: string) => {
        outbound.push({ target: t, text });
        return true;
      },
      sendTyping: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined,
    };

    const groupTarget: ReplyTarget = {
      scope: "group",
      targetId: "group-openid-1",
      msgId: "gm-model",
    };
    await runtime.handleQqMessage(
      "<@0123456789ABCDEF0123456789ABCDEF> /model",
      groupTarget,
      "member-openid",
      new PipelineTrace(),
      "group:group-openid-1",
    );

    assert.equal(adapter.sent.length, 0);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0]!.target.scope, "group");
    assert.equal(outbound[0]!.target.targetId, "group-openid-1");
    assert.match(outbound[0]!.text, /Fake Agent|model|Backend/i);
    await runtime.stop();
  });
});
