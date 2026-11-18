import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter, AgentTurnHooks, AgentTurnOptions } from "../src/types.js";
import type { ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { saveConfig, defaultConfig } from "../src/config/store.js";
import { BridgeRuntime, resetRuntimeForTests } from "../src/bridge/runtime.js";
import { PipelineTrace } from "../src/bridge/pipeline-trace.js";
import {
  clearBridgeActionsForTests,
  lastDeliveredImageQuery,
  recordBridgeAction,
} from "../src/bridge/recent-actions.js";
import { MemoryManager, resetMemoryManagerForTests } from "../src/memory/manager.js";
import { MemoryStore } from "../src/memory/store.js";
import {
  CultureManager,
  resetCultureManagerForTests,
} from "../src/culture/manager.js";
import {
  clearImageSessionForTests,
  getImageSession,
  parseImageIntent,
  rememberImageDelivered,
  resetImageMediaServiceForTests,
  resolveLastImageQuery,
  resolvePendingImageQuery,
  setPendingImageRequest,
  type ImageMediaService,
} from "../src/media/index.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-imgsess-"));
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
    return "sess-img-session";
  }
  async send(message: string): Promise<void> {
    await this.sendAndCollect(message, "sess-img-session");
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
    return `echo:${message}`;
  }
}

function okOutcome(id: string, title: string) {
  return {
    ok: true as const,
    delivery: "image" as const,
    hit: {
      id,
      provider: "openverse" as const,
      title,
      url: `https://cdn.example.com/${id}.png`,
    },
    downloaded: {
      buffer: PNG_1X1,
      contentType: "image/png",
      finalUrl: `https://cdn.example.com/${id}.png`,
      byteLength: PNG_1X1.length,
    },
    chatReply: "发你了～",
    attribution: "test",
    caption: "发你了～",
  };
}

function stubService(calls: Array<{ q: string; prefer?: boolean; many?: number }>) {
  const findAndDownload = async (
    q: string,
    _c: string,
    opts?: { preferDifferent?: boolean },
  ) => {
    calls.push({ q, prefer: opts?.preferDifferent });
    return okOutcome(`hit-${calls.length}`, q);
  };
  return {
    enabled: true,
    findAndDownload,
    findAndDownloadMany: async (
      q: string,
      c: string,
      opts?: { preferDifferent?: boolean; count?: number },
    ) => {
      const n = Math.max(1, opts?.count ?? 1);
      calls.push({ q, prefer: opts?.preferDifferent, many: n });
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push(await findAndDownload(q, c, { preferDifferent: true }));
      }
      return out;
    },
  } as unknown as ImageMediaService;
}

describe("image session + multi-turn follow-ups", () => {
  let dataDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dataDir = tempDataDir();
    prev = process.env.QQBRIDGE_DATA_DIR;
    process.env.QQBRIDGE_DATA_DIR = dataDir;
    clearBridgeActionsForTests();
    clearImageSessionForTests();
    resetRuntimeForTests();
    resetImageMediaServiceForTests(undefined);
    resetMemoryManagerForTests(
      new MemoryManager({
        store: new MemoryStore({ dbPath: ":memory:" }),
        config: { enabled: true, maintenanceIdleMs: 60_000 },
      }),
    );
    resetCultureManagerForTests(
      new CultureManager({ dbPath: ":memory:", skipSeed: true, config: { enabled: true } }),
    );
    const cfg = defaultConfig();
    cfg.allowlist.c2cMode = "open";
    cfg.allowlist.groupMode = "allowlist";
    cfg.allowlist.groups = ["group-openid-1"];
    cfg.bridge.requireApprovalForDangerous = false;
    cfg.bridge.images = {
      enabled: true,
      rateLimitPerMinute: 100,
      maxDownloadBytes: 1_000_000,
    };
    saveConfig(cfg);
  });

  afterEach(async () => {
    clearBridgeActionsForTests();
    clearImageSessionForTests();
    resetImageMediaServiceForTests(undefined);
    resetRuntimeForTests();
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

  it("intent: exact bug conversation phrases with context", () => {
    const last = { lastImageQuery: "张元英" };
    assert.deepEqual(parseImageIntent("换一批", last), {
      kind: "search",
      query: "张元英",
      preferDifferent: true,
      count: 2,
    });
    assert.deepEqual(parseImageIntent("继续张元英", last), {
      kind: "search",
      query: "张元英",
      preferDifferent: true,
    });
    assert.equal(parseImageIntent("发啊", last).kind, "none");
    assert.deepEqual(
      parseImageIntent("发啊", { ...last, pendingImageQuery: "张元英" }),
      { kind: "search", query: "张元英", preferDifferent: true },
    );
  });

  it("intent: 换一批 / bare 继续 / 发啊 without context stay none", () => {
    assert.equal(parseImageIntent("换一批").kind, "none");
    assert.equal(parseImageIntent("继续").kind, "none");
    assert.equal(parseImageIntent("发啊").kind, "none");
    assert.equal(parseImageIntent("继续说").kind, "none");
    assert.equal(parseImageIntent("继续聊").kind, "none");
  });

  it("intent: 继续张元英 works without prior last (named subject)", () => {
    assert.deepEqual(parseImageIntent("继续张元英"), {
      kind: "search",
      query: "张元英",
    });
  });

  it("intent: 发啊 during unrelated chat (last only, no pending) stays none", () => {
    assert.equal(
      parseImageIntent("发啊", { lastImageQuery: "张元英" }).kind,
      "none",
    );
  });

  it("session state is isolated per QQ conversation", () => {
    rememberImageDelivered("c2c:a", "张元英");
    setPendingImageRequest("c2c:b", "申有娜");
    assert.equal(resolveLastImageQuery("c2c:a"), "张元英");
    assert.equal(resolvePendingImageQuery("c2c:a"), undefined);
    assert.equal(resolveLastImageQuery("c2c:b"), undefined);
    assert.equal(resolvePendingImageQuery("c2c:b"), "申有娜");
    assert.equal(
      parseImageIntent("换一批", {
        lastImageQuery: resolveLastImageQuery("c2c:b"),
        pendingImageQuery: resolvePendingImageQuery("c2c:b"),
      }).kind,
      "none",
    );
    assert.deepEqual(
      parseImageIntent("发啊", {
        lastImageQuery: resolveLastImageQuery("c2c:b"),
        pendingImageQuery: resolvePendingImageQuery("c2c:b"),
      }),
      { kind: "search", query: "申有娜", preferDifferent: true },
    );
  });

  it("runtime: exact conversation 换一批 → 继续张元英 → 发啊 after IMAGE_SENT", async () => {
    const conv = "c2c:user-zhang";
    recordBridgeAction({
      kind: "image_search_send",
      status: "sent",
      conversationId: conv,
      query: "张元英",
      title: "Jang Won-young",
      provider: "openverse",
      imageId: "openverse:wonyoung1",
      delivered: true,
    });
    rememberImageDelivered(conv, "张元英");
    assert.equal(lastDeliveredImageQuery(conv), "张元英");

    const calls: Array<{ q: string; prefer?: boolean; many?: number }> = [];
    resetImageMediaServiceForTests(stubService(calls));

    const runtime = new BridgeRuntime();
    const adapter = new CaptureAdapter();
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;
    const images: Buffer[] = [];
    (runtime as unknown as { transport: Record<string, unknown> }).transport = {
      sendText: async () => true,
      sendImageBuffer: async (_t: ReplyTarget, buf: Buffer) => {
        images.push(buf);
        return true;
      },
      sendTyping: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined,
    };

    const target = { scope: "c2c", targetId: "user-zhang" } as ReplyTarget;

    await runtime.handleQqMessage(
      "换一批",
      target,
      "user-zhang",
      new PipelineTrace(),
      conv,
    );
    assert.equal(adapter.sent.length, 0, "换一批 must not reach Codex");
    assert.ok(images.length >= 1, "换一批 should send image(s)");
    assert.ok(calls.some((c) => c.q === "张元英"));

    const afterBatch = images.length;
    await runtime.handleQqMessage(
      "继续张元英",
      target,
      "user-zhang",
      new PipelineTrace(),
      conv,
    );
    assert.equal(adapter.sent.length, 0, "继续张元英 must not reach Codex");
    assert.ok(images.length > afterBatch, "继续张元英 should send another image");

    // Simulate failed delivery leaving pending, then nudge「发啊」.
    clearImageSessionForTests(conv);
    rememberImageDelivered(conv, "张元英");
    setPendingImageRequest(conv, "张元英", { preferDifferent: true });
    const beforeNudge = images.length;
    await runtime.handleQqMessage(
      "发啊",
      target,
      "user-zhang",
      new PipelineTrace(),
      conv,
    );
    assert.equal(adapter.sent.length, 0, "发啊 must not reach Codex");
    assert.ok(images.length > beforeNudge, "发啊 should fulfill pending");
    assert.equal(getImageSession(conv).pendingImageQuery, undefined);
    assert.equal(getImageSession(conv).lastImageQuery, "张元英");

    await runtime.stop();
  });

  it("runtime: 换一批 without previous image context stays with Agent", async () => {
    const calls: Array<{ q: string }> = [];
    resetImageMediaServiceForTests(stubService(calls));

    const runtime = new BridgeRuntime();
    const adapter = new CaptureAdapter();
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;
    (runtime as unknown as { transport: Record<string, unknown> }).transport = {
      sendText: async () => true,
      sendImageBuffer: async () => true,
      sendTyping: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined,
    };

    await runtime.handleQqMessage(
      "换一批",
      { scope: "c2c", targetId: "user-x" } as ReplyTarget,
      "user-x",
      new PipelineTrace(),
      "c2c:user-x",
    );
    assert.equal(calls.length, 0);
    assert.equal(adapter.sent.length, 1);
    assert.match(adapter.sent[0]!, /换一批/);
    await runtime.stop();
  });

  it("runtime: 发啊 after explicit request that failed keeps pending and retries", async () => {
    const conv = "c2c:user-fa";
    let attempt = 0;
    resetImageMediaServiceForTests({
      enabled: true,
      findAndDownload: async (q: string) => {
        attempt += 1;
        if (attempt === 1) {
          return { ok: false as const, error: "暂时没找到合适的图。" };
        }
        return okOutcome("retry-1", q);
      },
      findAndDownloadMany: async () => {
        throw new Error("unexpected many");
      },
    } as unknown as ImageMediaService);

    const runtime = new BridgeRuntime();
    const adapter = new CaptureAdapter();
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;
    const images: Buffer[] = [];
    const texts: string[] = [];
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

    const target = { scope: "c2c", targetId: "user-fa" } as ReplyTarget;
    await runtime.handleQqMessage(
      "来张张元英",
      target,
      "user-fa",
      new PipelineTrace(),
      conv,
    );
    assert.equal(images.length, 0);
    assert.match(texts.join("\n"), /没找到/);
    assert.equal(resolvePendingImageQuery(conv), "张元英");

    await runtime.handleQqMessage(
      "发啊",
      target,
      "user-fa",
      new PipelineTrace(),
      conv,
    );
    assert.equal(adapter.sent.length, 0);
    assert.equal(images.length, 1);
    assert.equal(resolvePendingImageQuery(conv), undefined);
    await runtime.stop();
  });

  it("runtime: 发啊 during unrelated conversation does not search", async () => {
    const calls: Array<{ q: string }> = [];
    resetImageMediaServiceForTests(stubService(calls));
    rememberImageDelivered("c2c:user-u", "张元英");

    const runtime = new BridgeRuntime();
    const adapter = new CaptureAdapter();
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;
    (runtime as unknown as { transport: Record<string, unknown> }).transport = {
      sendText: async () => true,
      sendImageBuffer: async () => true,
      sendTyping: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined,
    };

    await runtime.handleQqMessage(
      "发啊",
      { scope: "c2c", targetId: "user-u" } as ReplyTarget,
      "user-u",
      new PipelineTrace(),
      "c2c:user-u",
    );
    assert.equal(calls.length, 0);
    assert.equal(adapter.sent.length, 1);
    await runtime.stop();
  });

  it("runtime: session isolation — 换一批 in A does not use B's subject", async () => {
    rememberImageDelivered("c2c:a", "张元英");
    rememberImageDelivered("c2c:b", "申有娜");
    recordBridgeAction({
      kind: "image_search_send",
      status: "sent",
      conversationId: "c2c:a",
      query: "张元英",
      delivered: true,
    });
    recordBridgeAction({
      kind: "image_search_send",
      status: "sent",
      conversationId: "c2c:b",
      query: "申有娜",
      delivered: true,
    });

    const calls: Array<{ q: string; conv?: string }> = [];
    resetImageMediaServiceForTests({
      enabled: true,
      findAndDownload: async (q: string, c: string) => {
        calls.push({ q, conv: c });
        return okOutcome("x", q);
      },
      findAndDownloadMany: async (
        q: string,
        c: string,
        opts?: { count?: number },
      ) => {
        const n = opts?.count ?? 2;
        calls.push({ q, conv: c });
        return Array.from({ length: n }, () => okOutcome("x", q));
      },
    } as unknown as ImageMediaService);

    const runtime = new BridgeRuntime();
    const adapter = new CaptureAdapter();
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;
    (runtime as unknown as { transport: Record<string, unknown> }).transport = {
      sendText: async () => true,
      sendImageBuffer: async () => true,
      sendTyping: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined,
    };

    await runtime.handleQqMessage(
      "换一批",
      { scope: "c2c", targetId: "b" } as ReplyTarget,
      "b",
      new PipelineTrace(),
      "c2c:b",
    );
    assert.ok(calls.every((c) => c.q === "申有娜"));
    assert.ok(calls.every((c) => c.conv === "c2c:b"));
    await runtime.stop();
  });
});
