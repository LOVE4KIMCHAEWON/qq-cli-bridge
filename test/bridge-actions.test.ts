import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearBridgeActionsForTests,
  lastDeliveredImageQuery,
  formatBridgeActionsSection,
  formatBridgeActionsTurnNote,
  listBridgeActions,
  recordBridgeAction,
  resetBridgeActionsStoreFileForTests,
  stripBridgeActionsTurnNote,
} from "../src/bridge/recent-actions.js";
import { assembleBridgeContext } from "../src/context/assemble.js";
import {
  PERSONA_SYSTEM_FRAMING_CLAUDE,
  PERSONA_SYSTEM_FRAMING_CODEX_RESTRICTED,
} from "../src/persona/default.js";
import { BridgeRuntime, resetRuntimeForTests } from "../src/bridge/runtime.js";
import { saveConfig, defaultConfig } from "../src/config/store.js";
import { MemoryManager, resetMemoryManagerForTests } from "../src/memory/manager.js";
import {
  CultureManager,
  resetCultureManagerForTests,
} from "../src/culture/manager.js";
import { MemoryStore } from "../src/memory/store.js";
import {
  ImageMediaService,
  resetImageMediaServiceForTests,
} from "../src/media/index.js";
import type { AgentAdapter, AgentTurnHooks, AgentTurnOptions } from "../src/types.js";
import type { ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { PipelineTrace } from "../src/bridge/pipeline-trace.js";
import { writeBridgeSessionPrompt } from "../src/context/session-prompt.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-ba-"));
}

class CaptureAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  readonly displayName = "Fake Codex";
  readonly supportsSessionResume = true;
  sent: string[] = [];
  onOutput(): void {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getSessionId(): string | undefined {
    return "sess-ba";
  }
  async send(message: string): Promise<void> {
    await this.sendAndCollect(message, "sess-ba");
  }
  async sendAndCollect(
    message: string,
    _sessionId: string,
    hooks?: AgentTurnHooks,
    _turn?: AgentTurnOptions,
  ): Promise<string> {
    this.sent.push(message);
    hooks?.onSpawn?.();
    hooks?.onFinal?.();
    return `echo:${message.slice(0, 40)}`;
  }
}

describe("Bridge recent actions store", () => {
  let dataDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dataDir = tempDataDir();
    prev = process.env.QQBRIDGE_DATA_DIR;
    process.env.QQBRIDGE_DATA_DIR = dataDir;
    resetBridgeActionsStoreFileForTests();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.QQBRIDGE_DATA_DIR;
    else process.env.QQBRIDGE_DATA_DIR = prev;
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("records sent vs failed and isolates conversations", () => {
    recordBridgeAction({
      kind: "image_search_send",
      status: "sent",
      conversationId: "c2c:a",
      query: "cat",
      title: "Cat bliss",
      provider: "openverse",
      delivered: true,
    });
    recordBridgeAction({
      kind: "image_search_send",
      status: "send_failed",
      conversationId: "c2c:a",
      query: "dog",
      error: "QQ sendImage failed",
    });
    recordBridgeAction({
      kind: "image_search_send",
      status: "sent",
      conversationId: "group:g1",
      query: "张元英",
      title: "Jang Wonyoung",
      delivered: true,
    });

    const a = listBridgeActions("c2c:a");
    assert.equal(a.length, 2);
    assert.equal(a[0]!.status, "send_failed");
    assert.equal(a[0]!.delivered, false);
    assert.equal(a[1]!.delivered, true);
    assert.equal(listBridgeActions("group:g1").length, 1);
    assert.equal(listBridgeActions("c2c:b").length, 0);

    const note = formatBridgeActionsTurnNote("c2c:a");
    assert.match(note, /IMAGE_SEND_FAILED/);
    assert.match(note, /IMAGE_SENT/);
    assert.match(note, /Bridge actions/);

    const section = formatBridgeActionsSection("group:g1");
    assert.match(section, /IMAGE_SENT/);
    assert.match(section, /张元英/);

    assert.equal(lastDeliveredImageQuery("c2c:a"), "cat");
    assert.equal(lastDeliveredImageQuery("group:g1"), "张元英");
    assert.equal(lastDeliveredImageQuery("c2c:missing"), undefined);
  });

  it("survives store reload (Bridge restart)", () => {
    recordBridgeAction({
      kind: "image_search_send",
      status: "sent",
      conversationId: "c2c:a",
      query: "cat",
      delivered: true,
    });
    clearBridgeActionsForTests(); // writes empty — use file roundtrip instead
    // Re-record then re-read via new process simulation: read file
    recordBridgeAction({
      kind: "image_search_send",
      status: "sent",
      conversationId: "c2c:restart",
      query: "wonyoung",
      title: "Jang Wonyoung",
      delivered: true,
    });
    const p = path.join(dataDir, "state", "bridge-recent-actions.json");
    assert.ok(fs.existsSync(p));
    const disk = JSON.parse(fs.readFileSync(p, "utf8")) as {
      byConversation: Record<string, unknown[]>;
    };
    assert.ok(disk.byConversation["c2c:restart"]?.length);
    assert.equal(listBridgeActions("c2c:restart")[0]!.query, "wonyoung");
  });

  it("strips turn notes for Memory archival", () => {
    const note = formatBridgeActionsTurnNote("c2c:x"); // empty
    assert.equal(note, "");
    recordBridgeAction({
      kind: "image_search_send",
      status: "sent",
      conversationId: "c2c:x",
      query: "cat",
      delivered: true,
    });
    const block = formatBridgeActionsTurnNote("c2c:x");
    const full = `${block}\n\n那你刚刚发的什么？`;
    assert.equal(stripBridgeActionsTurnNote(full), "那你刚刚发的什么？");
  });
});

describe("capability framing mentions Bridge media", () => {
  it("Claude and Codex framing agree Bridge can send images", () => {
    assert.match(PERSONA_SYSTEM_FRAMING_CLAUDE, /Bridge can search(?: and send)?(?: existing)? openly licensed images/i);
    assert.match(PERSONA_SYSTEM_FRAMING_CLAUDE, /Do not tell the user to type slash commands/i);
    assert.match(PERSONA_SYSTEM_FRAMING_CLAUDE, /IMAGE_SENT/);
    assert.doesNotMatch(
      PERSONA_SYSTEM_FRAMING_CLAUDE,
      /Capabilities: text chat only\. No tools, no web browsing/,
    );

    assert.match(PERSONA_SYSTEM_FRAMING_CODEX_RESTRICTED, /Bridge can search/i);
    assert.match(PERSONA_SYSTEM_FRAMING_CODEX_RESTRICTED, /web_search/);

    const withActions = assembleBridgeContext({
      personaBody: "Be casual",
      capabilityProfile: "codex-restricted",
      bridgeActionsSection: "## Bridge recent actions\n1. IMAGE_SENT query=\"cat\"\n",
    });
    assert.ok(withActions.sections.includes("bridgeActions"));
    assert.match(withActions.fullText, /IMAGE_SENT/);
  });
});

describe("runtime injects Bridge actions into Claude/Codex turns", () => {
  let dataDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dataDir = tempDataDir();
    prev = process.env.QQBRIDGE_DATA_DIR;
    process.env.QQBRIDGE_DATA_DIR = dataDir;
    resetRuntimeForTests();
    resetBridgeActionsStoreFileForTests();
    resetImageMediaServiceForTests(undefined);
    resetMemoryManagerForTests(
      new MemoryManager({
        store: new MemoryStore({ dbPath: ":memory:" }),
        config: { enabled: true, maintenanceIdleMs: 60_000 },
      }),
    );
    resetCultureManagerForTests(
      new CultureManager({
        dbPath: ":memory:",
        skipSeed: true,
        config: { enabled: true },
      }),
    );
  });

  afterEach(() => {
    resetRuntimeForTests();
    resetImageMediaServiceForTests(undefined);
    resetMemoryManagerForTests(undefined);
    resetCultureManagerForTests(undefined);
    if (prev === undefined) delete process.env.QQBRIDGE_DATA_DIR;
    else process.env.QQBRIDGE_DATA_DIR = prev;
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function wire(adapter: CaptureAdapter) {
    const cfg = defaultConfig();
    cfg.allowlist.c2cMode = "open";
    cfg.bridge.requireApprovalForDangerous = false;
    cfg.bridge.images = { enabled: true, rateLimitPerMinute: 100 };
    saveConfig(cfg);

    const runtime = new BridgeRuntime();
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;
    const texts: string[] = [];
    const images: Buffer[] = [];
    (runtime as unknown as { transport: Record<string, unknown> }).transport = {
      sendText: async (_t: ReplyTarget, text: string) => {
        texts.push(text);
        return true;
      },
      sendImageBuffer: async (_t: ReplyTarget, buf: Buffer) => {
        images.push(buf);
        return true;
      },
      sendTyping: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined,
    };

    resetImageMediaServiceForTests({
      enabled: true,
      findAndDownload: async () => ({
        ok: true as const,
        delivery: "image" as const,
        hit: {
          id: "openverse:cat1",
          provider: "openverse" as const,
          title: "Cat bliss",
          url: "https://cdn.example.com/cat.png",
          attribution: "via Openverse",
        },
        downloaded: {
          buffer: PNG_1X1,
          contentType: "image/png",
          finalUrl: "https://cdn.example.com/cat.png",
          byteLength: PNG_1X1.length,
        },
        chatReply: "这张不错",
        attribution: "via Openverse",
        caption: "这张不错",
      }),
    } as unknown as ImageMediaService);

    return { runtime, texts, images };
  }

  it("after successful image send, follow-up includes IMAGE_SENT for the model", async () => {
    const adapter = new CaptureAdapter();
    const { runtime, images } = wire(adapter);

    await runtime.handleQqMessage(
      "/image cat",
      { scope: "c2c", targetId: "user-a" } as ReplyTarget,
      "user-a",
      new PipelineTrace(),
      "c2c:user-a",
    );
    assert.equal(images.length, 1);
    assert.equal(adapter.sent.length, 0);

    await runtime.handleQqMessage(
      "那你刚刚发的什么？",
      { scope: "c2c", targetId: "user-a" } as ReplyTarget,
      "user-a",
      new PipelineTrace(),
      "c2c:user-a",
    );
    assert.equal(adapter.sent.length, 1);
    assert.match(adapter.sent[0]!, /IMAGE_SENT/);
    assert.match(adapter.sent[0]!, /cat/i);
    assert.match(adapter.sent[0]!, /那你刚刚发的什么/);
    await runtime.stop();
  });

  it("records send_failed without claiming delivery", async () => {
    const adapter = new CaptureAdapter();
    const cfg = defaultConfig();
    cfg.allowlist.c2cMode = "open";
    cfg.bridge.requireApprovalForDangerous = false;
    cfg.bridge.images = { enabled: true, rateLimitPerMinute: 100 };
    saveConfig(cfg);
    const runtime = new BridgeRuntime();
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;
    (runtime as unknown as { transport: Record<string, unknown> }).transport = {
      sendText: async () => true,
      sendImageBuffer: async () => false,
      sendTyping: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined,
    };
    resetImageMediaServiceForTests({
      enabled: true,
      findAndDownload: async () => ({
        ok: true as const,
        delivery: "image" as const,
        hit: {
          id: "openverse:x",
          provider: "openverse" as const,
          title: "X",
          url: "https://cdn.example.com/x.png",
        },
        downloaded: {
          buffer: PNG_1X1,
          contentType: "image/png",
          finalUrl: "https://cdn.example.com/x.png",
          byteLength: PNG_1X1.length,
        },
        chatReply: "这张不错",
        attribution: "x",
        caption: "这张不错",
      }),
    } as unknown as ImageMediaService);

    await runtime.handleQqMessage(
      "/image cat",
      { scope: "c2c", targetId: "user-a" } as ReplyTarget,
      "user-a",
      new PipelineTrace(),
      "c2c:user-a",
    );
    const acts = listBridgeActions("c2c:user-a");
    assert.equal(acts[0]!.status, "send_failed");
    assert.equal(acts[0]!.delivered, false);

    await runtime.handleQqMessage(
      "发成功了吗",
      { scope: "c2c", targetId: "user-a" } as ReplyTarget,
      "user-a",
      new PipelineTrace(),
      "c2c:user-a",
    );
    assert.match(adapter.sent[0]!, /IMAGE_SEND_FAILED/);
    assert.doesNotMatch(adapter.sent[0]!, /IMAGE_SENT/);
    await runtime.stop();
  });

  it("session prompt includes Bridge actions after a send (rotation path)", async () => {
    recordBridgeAction({
      kind: "image_search_send",
      status: "sent",
      conversationId: "c2c:rot",
      query: "cat",
      title: "Cat",
      delivered: true,
    });
    const written = writeBridgeSessionPrompt("Be casual", "c2c:rot");
    assert.ok(written.sections.includes("bridgeActions"));
    assert.match(written.fullText, /IMAGE_SENT/);
    assert.match(fs.readFileSync(written.path, "utf8"), /IMAGE_SENT/);
  });

  it("does not leak actions across conversations", async () => {
    const adapter = new CaptureAdapter();
    const { runtime } = wire(adapter);
    await runtime.handleQqMessage(
      "/image cat",
      { scope: "c2c", targetId: "user-a" } as ReplyTarget,
      "user-a",
      new PipelineTrace(),
      "c2c:user-a",
    );
    await runtime.handleQqMessage(
      "hi",
      { scope: "c2c", targetId: "user-b" } as ReplyTarget,
      "user-b",
      new PipelineTrace(),
      "c2c:user-b",
    );
    assert.equal(adapter.sent.length, 1);
    assert.doesNotMatch(adapter.sent[0]!, /IMAGE_SENT/);
    await runtime.stop();
  });
});
