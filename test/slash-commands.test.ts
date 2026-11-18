import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSlashCommand } from "../src/commands/parse.js";
import { routeSlashCommand } from "../src/commands/router.js";
import { formatHelpText } from "../src/commands/help.js";
import {
  getConversationModel,
  setConversationModel,
} from "../src/models/conversation-store.js";
import {
  injectModelArg,
  parseAgentModelList,
  parseCodexModelJson,
  parseGeminiModelJson,
} from "../src/models/parse-list.js";
import { formatModelStatus } from "../src/models/format.js";
import type { AgentAdapter, AgentTurnHooks, AgentTurnOptions } from "../src/types.js";
import type { ModelCatalog, ModelSwitchResult } from "../src/models/types.js";
import { MessageDeduper } from "../src/bridge/message-dedupe.js";
import { BridgeRuntime, resetRuntimeForTests } from "../src/bridge/runtime.js";
import { saveConfig, defaultConfig } from "../src/config/store.js";
import type { ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { MemoryManager, resetMemoryManagerForTests } from "../src/memory/manager.js";
import {
  CultureManager,
  resetCultureManagerForTests,
} from "../src/culture/manager.js";
import { MemoryStore } from "../src/memory/store.js";

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-model-"));
}

function writeOpenConfig(): void {
  const cfg = defaultConfig();
  cfg.allowlist.c2cMode = "open";
  cfg.bridge.requireApprovalForDangerous = false;
  saveConfig(cfg);
}

class FakeModelAdapter implements AgentAdapter {
  readonly kind = "agent" as const;
  readonly displayName = "Fake Agent";
  readonly supportsSessionResume = true;
  sessionId = "sess-1";
  catalog: ModelCatalog = {
    backend: "Fake Agent",
    discovery: "dynamic",
    models: [
      { id: "auto", displayName: "Auto", current: true, isDefault: true },
      { id: "composer-2.5", displayName: "Composer 2.5" },
    ],
  };
  lastTurnModel: string | undefined;
  sent: string[] = [];

  onOutput(): void {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getSessionId(): string | undefined {
    return this.sessionId;
  }
  async send(message: string): Promise<void> {
    await this.sendAndCollect(message, this.sessionId);
  }
  async sendAndCollect(
    message: string,
    _sessionId: string,
    hooks?: AgentTurnHooks,
    turn?: AgentTurnOptions,
  ): Promise<string> {
    this.sent.push(message);
    this.lastTurnModel = turn?.modelId;
    hooks?.onSpawn?.();
    hooks?.onFinal?.();
    return `echo:${message}|model:${turn?.modelId ?? "default"}`;
  }
  async listModels(): Promise<ModelCatalog> {
    return this.catalog;
  }
  async resolveModelSwitch(modelId: string | "default"): Promise<ModelSwitchResult> {
    if (modelId === "default") {
      return {
        ok: true,
        effectiveModelId: undefined,
        message: "Restored default.",
      };
    }
    const hit = this.catalog.models.find(
      (m) => m.id.toLowerCase() === modelId.toLowerCase(),
    );
    if (!hit) {
      return { ok: false, message: `Model "${modelId}" is not available.` };
    }
    return {
      ok: true,
      effectiveModelId: hit.id,
      message: `Switched to ${hit.id}.`,
    };
  }
}

describe("parseSlashCommand", () => {
  it("parses /model and /help", () => {
    assert.deepEqual(parseSlashCommand("/help"), {
      name: "help",
      args: [],
      raw: "/help",
    });
    assert.deepEqual(parseSlashCommand("/model"), {
      name: "model",
      args: [],
      raw: "/model",
    });
    assert.deepEqual(parseSlashCommand("/model composer-2.5"), {
      name: "model",
      args: ["composer-2.5"],
      raw: "/model composer-2.5",
    });
    assert.deepEqual(parseSlashCommand("/model default"), {
      name: "model",
      args: ["default"],
      raw: "/model default",
    });
  });

  it("recognizes group @bot mention markers before /command", () => {
    const hex = "<@0123456789ABCDEF0123456789ABCDEF> /model";
    assert.deepEqual(parseSlashCommand(hex), {
      name: "model",
      args: [],
      raw: "/model",
    });
    assert.deepEqual(parseSlashCommand("<@!123456789> /help"), {
      name: "help",
      args: [],
      raw: "/help",
    });
    assert.deepEqual(
      parseSlashCommand("<@0123456789ABCDEF0123456789ABCDEF>   /model composer-2.5"),
      {
        name: "model",
        args: ["composer-2.5"],
        raw: "/model composer-2.5",
      },
    );
    assert.deepEqual(
      parseSlashCommand("  <@bot> \t /memory list  "),
      {
        name: "memory",
        args: ["list"],
        raw: "/memory list",
      },
    );
  });

  it("ignores non-commands", () => {
    assert.equal(parseSlashCommand("hello"), undefined);
    assert.equal(parseSlashCommand("use /model please"), undefined);
    assert.equal(parseSlashCommand("//comment"), undefined);
    assert.equal(
      parseSlashCommand("<@0123456789ABCDEF0123456789ABCDEF> hello /model"),
      undefined,
    );
  });
});

describe("model list parsers", () => {
  it("parses Cursor agent --list-models text", () => {
    const text = `Available models

auto - Auto (current, default)
composer-2.5 - Composer 2.5
gpt-5.2 - GPT-5.2

Tip: use --model <id>`;
    const models = parseAgentModelList(text);
    assert.equal(models.length, 3);
    assert.equal(models[0]!.id, "auto");
    assert.equal(models[0]!.current, true);
    assert.equal(models[0]!.isDefault, true);
    assert.equal(models[1]!.id, "composer-2.5");
    assert.equal(models[1]!.displayName, "Composer 2.5");
  });

  it("parses Gemini JSON model arrays", () => {
    const models = parseGeminiModelJson(
      JSON.stringify([
        { modelId: "gemini-2.5-flash", displayName: "Flash" },
        { id: "gemini-2.5-pro", name: "Pro" },
      ]),
    );
    assert.equal(models.length, 2);
    assert.equal(models[0]!.id, "gemini-2.5-flash");
  });

  it("parses Codex debug models JSON", () => {
    const models = parseCodexModelJson(
      JSON.stringify({
        models: [
          { slug: "gpt-5.3-codex", display_name: "Codex", visibility: "list" },
          { slug: "hidden", visibility: "hidden" },
        ],
      }),
    );
    assert.equal(models.length, 1);
    assert.equal(models[0]!.id, "gpt-5.3-codex");
  });

  it("injects --model without duplicating", () => {
    assert.deepEqual(injectModelArg(["-p", "hi"], "auto"), [
      "--model",
      "auto",
      "-p",
      "hi",
    ]);
    assert.deepEqual(injectModelArg(["--model", "old", "-p", "hi"], "new"), [
      "--model",
      "new",
      "-p",
      "hi",
    ]);
    assert.deepEqual(injectModelArg(["-p", "hi"], undefined), ["-p", "hi"]);
  });
});

describe("slash router — /model and /help", () => {
  let dataDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dataDir = tempDataDir();
    prev = process.env.QQBRIDGE_DATA_DIR;
    process.env.QQBRIDGE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.QQBRIDGE_DATA_DIR;
    else process.env.QQBRIDGE_DATA_DIR = prev;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("/model without args shows catalog", async () => {
    const adapter = new FakeModelAdapter();
    const result = await routeSlashCommand("/model", {
      adapter,
      conversationId: "c2c:user-a",
      senderId: "user-a",
    });
    assert.equal(result.handled, true);
    assert.match(result.reply ?? "", /Backend: Fake Agent/);
    assert.match(result.reply ?? "", /1\. auto/);
    assert.match(result.reply ?? "", /2\. composer-2\.5/);
  });

  it("switches to a valid model and rejects invalid", async () => {
    const adapter = new FakeModelAdapter();
    const ok = await routeSlashCommand("/model composer-2.5", {
      adapter,
      conversationId: "c2c:user-a",
      senderId: "user-a",
    });
    assert.equal(ok.handled, true);
    assert.match(ok.reply ?? "", /Effective model: composer-2\.5/);
    assert.equal(
      getConversationModel("c2c:user-a")?.modelId,
      "composer-2.5",
    );

    const bad = await routeSlashCommand("/model nope-model", {
      adapter,
      conversationId: "c2c:user-a",
      senderId: "user-a",
    });
    assert.match(bad.reply ?? "", /not available/);
    // Preference unchanged
    assert.equal(
      getConversationModel("c2c:user-a")?.modelId,
      "composer-2.5",
    );
  });

  it("/model default restores CLI default", async () => {
    const adapter = new FakeModelAdapter();
    setConversationModel("c2c:user-a", "agent", "composer-2.5");
    const result = await routeSlashCommand("/model default", {
      adapter,
      conversationId: "c2c:user-a",
      senderId: "user-a",
    });
    assert.match(result.reply ?? "", /Effective model: \(CLI default\)/);
    assert.equal(getConversationModel("c2c:user-a")?.modelId, undefined);
  });

  it("reports unsupported discovery without inventing models", async () => {
    const adapter = new FakeModelAdapter();
    adapter.catalog = {
      backend: "Fake Agent",
      discovery: "unavailable",
      models: [],
      note: "CLI not installed.",
    };
    const result = await routeSlashCommand("/model", {
      adapter,
      conversationId: "c2c:user-a",
      senderId: "user-a",
    });
    assert.match(result.reply ?? "", /dynamic discovery unavailable/);
    assert.doesNotMatch(result.reply ?? "", /1\. /);
  });

  it("/help lists bridge commands", async () => {
    const result = await routeSlashCommand("/help", {
      conversationId: "c2c:user-a",
      senderId: "user-a",
    });
    assert.equal(result.handled, true);
    assert.equal(result.reply, formatHelpText());
    assert.match(result.reply ?? "", /\/model/);
  });

  it("does not forward unknown slash commands to the agent", async () => {
    const adapter = new FakeModelAdapter();
    const result = await routeSlashCommand("/agent", {
      adapter,
      conversationId: "c2c:user-a",
      senderId: "user-a",
    });
    assert.equal(result.handled, true);
    assert.match(result.reply ?? "", /Unknown command/);
    assert.equal(adapter.sent.length, 0);
  });

  it("isolates model prefs across conversations", async () => {
    const adapter = new FakeModelAdapter();
    await routeSlashCommand("/model composer-2.5", {
      adapter,
      conversationId: "c2c:user-a",
      senderId: "a",
    });
    await routeSlashCommand("/model auto", {
      adapter,
      conversationId: "c2c:user-b",
      senderId: "b",
    });
    assert.equal(getConversationModel("c2c:user-a")?.modelId, "composer-2.5");
    assert.equal(getConversationModel("c2c:user-b")?.modelId, "auto");
  });
});

describe("formatModelStatus", () => {
  it("labels documented aliases", () => {
    const text = formatModelStatus({
      backend: "Claude Code",
      discovery: "documented-aliases",
      note: "No live catalog.",
      models: [{ id: "sonnet", displayName: "Sonnet (alias)" }],
      effectiveModelId: "sonnet",
    });
    assert.match(text, /documented aliases/i);
    assert.match(text, /Current model: sonnet/);
  });
});

describe("slash-command dedupe + runtime wiring", () => {
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

  it("dedupes identical slash-command deliveries", () => {
    const deduper = new MessageDeduper({ windowMs: 60_000 });
    const identity = {
      messageId: "slash-1",
      conversationId: "c2c:user-a",
      timestamp: "2026-11-17T05:00:00Z",
    };
    assert.equal(deduper.tryClaim(identity).result, "claimed");
    assert.equal(deduper.tryClaim(identity).result, "duplicate");
  });

  it("applies per-conversation model on agent turns and preserves resume session", async () => {
    writeOpenConfig();
    const runtime = new BridgeRuntime();
    const adapter = new FakeModelAdapter();
    const replies: string[] = [];

    // Inject adapter + stub transport without starting QQ.
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;
    (runtime as unknown as { transport: { sendText: Function; sendTyping: Function; isConnected: Function } }).transport =
      {
        sendText: async (_t: ReplyTarget, text: string) => {
          replies.push(text);
          return true;
        },
        sendTyping: async () => {},
        isConnected: () => true,
      };

    const target = {
      scope: "c2c",
      targetId: "user-a",
    } as ReplyTarget;

    await runtime.handleQqMessage(
      "/model composer-2.5",
      target,
      "user-a",
      undefined,
      "c2c:user-a",
    );
    assert.match(replies.at(-1) ?? "", /composer-2\.5/);

    await runtime.handleQqMessage(
      "hello after switch",
      target,
      "user-a",
      undefined,
      "c2c:user-a",
    );
    assert.equal(adapter.lastTurnModel, "composer-2.5");
    assert.equal(adapter.sessionId, "sess-1");
    assert.match(replies.at(-1) ?? "", /model:composer-2\.5/);

    // Other conversation keeps default
    const targetB = { scope: "c2c", targetId: "user-b" } as ReplyTarget;
    await runtime.handleQqMessage(
      "hello b",
      targetB,
      "user-b",
      undefined,
      "c2c:user-b",
    );
    assert.equal(adapter.lastTurnModel, undefined);
    assert.equal(adapter.sent.includes("/model composer-2.5"), false);
  });

  it("keeps normal QQ handling functional for non-slash text", async () => {
    writeOpenConfig();
    const runtime = new BridgeRuntime();
    const adapter = new FakeModelAdapter();
    const replies: string[] = [];
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;
    (runtime as unknown as { transport: { sendText: Function; sendTyping: Function; isConnected: Function } }).transport =
      {
        sendText: async (_t: ReplyTarget, text: string) => {
          replies.push(text);
          return true;
        },
        sendTyping: async () => {},
        isConnected: () => true,
      };

    await runtime.handleQqMessage(
      "ping",
      { scope: "c2c", targetId: "u" } as ReplyTarget,
      "u",
      undefined,
      "c2c:u",
    );
    assert.equal(adapter.sent[0], "ping");
    assert.match(replies[0] ?? "", /echo:ping/);
  });

  it("C2C /model is handled locally and never reaches the model", async () => {
    writeOpenConfig();
    const runtime = new BridgeRuntime();
    const adapter = new FakeModelAdapter();
    const replies: string[] = [];
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;
    (runtime as unknown as { transport: { sendText: Function; sendTyping: Function; isConnected: Function } }).transport =
      {
        sendText: async (_t: ReplyTarget, text: string) => {
          replies.push(text);
          return true;
        },
        sendTyping: async () => {},
        isConnected: () => true,
      };

    await runtime.handleQqMessage(
      "/model",
      { scope: "c2c", targetId: "user-a" } as ReplyTarget,
      "user-a",
      undefined,
      "c2c:user-a",
    );
    assert.equal(adapter.sent.length, 0);
    assert.match(replies.at(-1) ?? "", /Backend: Fake Agent/);
  });

  it("group @bot /model uses shared router and group reply target", async () => {
    writeOpenConfig();
    const runtime = new BridgeRuntime();
    const adapter = new FakeModelAdapter();
    const replies: { target: ReplyTarget; text: string }[] = [];
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;
    (runtime as unknown as { transport: { sendText: Function; sendTyping: Function; isConnected: Function } }).transport =
      {
        sendText: async (t: ReplyTarget, text: string) => {
          replies.push({ target: t, text });
          return true;
        },
        sendTyping: async () => {},
        isConnected: () => true,
      };

    const groupTarget = {
      scope: "group",
      targetId: "group-openid-1",
      msgId: "gm-slash-1",
    } as ReplyTarget;

    await runtime.handleQqMessage(
      "<@0123456789ABCDEF0123456789ABCDEF> /model",
      groupTarget,
      "member-1",
      undefined,
      "group:group-openid-1",
    );
    assert.equal(adapter.sent.length, 0, "slash must not reach the model");
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.target.scope, "group");
    assert.equal(replies[0]!.target.targetId, "group-openid-1");
    assert.match(replies[0]!.text, /Backend: Fake Agent/);

    await runtime.handleQqMessage(
      "<@0123456789ABCDEF0123456789ABCDEF>  /model composer-2.5",
      groupTarget,
      "member-1",
      undefined,
      "group:group-openid-1",
    );
    assert.equal(adapter.sent.length, 0);
    assert.match(replies.at(-1)!.text, /composer-2\.5/);

    await runtime.handleQqMessage(
      "<@bot> /nosuchcmd",
      groupTarget,
      "member-1",
      undefined,
      "group:group-openid-1",
    );
    assert.equal(adapter.sent.length, 0);
    assert.match(replies.at(-1)!.text, /Unknown command/);
  });
});
