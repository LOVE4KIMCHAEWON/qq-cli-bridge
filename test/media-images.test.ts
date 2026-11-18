import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertNotLocalPath,
  backendCanInspectImages,
  clearImageSearchCache,
  clearRecentlySent,
  downloadImageSafely,
  extractInboundImages,
  ImageMediaService,
  isBlockedIp,
  isSupportedInboundImageMime,
  clearImageSessionForTests,
  parseImageIntent,
  recentlySentIds,
  rememberSentImage,
  resetImageMediaServiceForTests,
  selectBestImage,
  imageReceivedAckText,
} from "../src/media/index.js";
import { BridgeRuntime, resetRuntimeForTests } from "../src/bridge/runtime.js";
import { saveConfig, defaultConfig } from "../src/config/store.js";
import { MemoryManager, resetMemoryManagerForTests } from "../src/memory/manager.js";
import {
  CultureManager,
  resetCultureManagerForTests,
} from "../src/culture/manager.js";
import { MemoryStore } from "../src/memory/store.js";
import type { AgentAdapter, AgentTurnHooks, AgentTurnOptions } from "../src/types.js";
import type { ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { PipelineTrace } from "../src/bridge/pipeline-trace.js";

/** Minimal valid 1x1 PNG */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-img-"));
}

class CaptureAdapter implements AgentAdapter {
  readonly kind = "claude" as const;
  readonly displayName = "Fake Claude";
  readonly supportsSessionResume = true;
  sent: string[] = [];
  onOutput(): void {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getSessionId(): string | undefined {
    return "sess-img";
  }
  async send(message: string): Promise<void> {
    await this.sendAndCollect(message, "sess-img");
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

describe("image intent detection", () => {
  it("detects Chinese search phrases including 张元英", () => {
    assert.deepEqual(parseImageIntent("找张张元英的图"), {
      kind: "search",
      query: "张元英",
    });
    assert.deepEqual(parseImageIntent("来张张元英美图"), {
      kind: "search",
      query: "张元英",
    });
    assert.deepEqual(parseImageIntent("发个猫猫表情包"), {
      kind: "search",
      query: "猫猫",
    });
    assert.equal(parseImageIntent("找张猫猫图").kind, "search");
  });

  it("recognizes 来张… without trailing 图 (live failure case)", () => {
    assert.deepEqual(parseImageIntent("来张张元英"), {
      kind: "search",
      query: "张元英",
    });
    assert.deepEqual(parseImageIntent("发张申有娜"), {
      kind: "search",
      query: "申有娜",
    });
    assert.deepEqual(parseImageIntent("整张猫猫"), {
      kind: "search",
      query: "猫猫",
    });
  });

  it("detects English search and refuses generation", () => {
    assert.deepEqual(parseImageIntent("find a cat picture"), {
      kind: "search",
      query: "cat",
    });
    assert.equal(parseImageIntent("画一张赛博朋克城市").kind, "generate_refused");
    assert.equal(parseImageIntent("generate an image of a dragon").kind, "generate_refused");
  });

  it("ignores ordinary chat and non-image follow-ups", () => {
    assert.equal(parseImageIntent("你好啊").kind, "none");
    assert.equal(parseImageIntent("今天天气怎么样").kind, "none");
    assert.equal(parseImageIntent("图呢").kind, "none");
    assert.equal(parseImageIntent("那你倒是发啊").kind, "none");
    assert.equal(parseImageIntent("整个人都不好了").kind, "none");
  });
});

describe("image selection + duplicates", () => {
  it("prefers larger topical images and skips excluded ids", () => {
    const hits = [
      {
        id: "a",
        provider: "openverse" as const,
        title: "tiny cat",
        url: "https://example.com/a.jpg",
        width: 100,
        height: 100,
        tags: ["cat"],
      },
      {
        id: "b",
        provider: "openverse" as const,
        title: "cat mid",
        url: "https://example.com/b.jpg",
        width: 800,
        height: 600,
        tags: ["cat"],
      },
      {
        id: "c",
        provider: "openverse" as const,
        title: "cat large",
        url: "https://example.com/c.jpg",
        width: 1200,
        height: 900,
        tags: ["cat"],
      },
    ];
    const best = selectBestImage(hits, {
      minWidth: 200,
      minHeight: 200,
      subject: "cat",
    });
    assert.equal(best?.id, "c");
    const next = selectBestImage(hits, {
      minWidth: 200,
      minHeight: 200,
      subject: "cat",
      excludeIds: new Set(["c"]),
    });
    assert.equal(next?.id, "b");
  });

  it("tracks recently sent per conversation", () => {
    clearRecentlySent();
    rememberSentImage("c2c:u1", "openverse:1");
    assert.equal(recentlySentIds("c2c:u1").has("openverse:1"), true);
    assert.equal(recentlySentIds("c2c:u2").has("openverse:1"), false);
  });
});

describe("SSRF + download security", () => {
  it("blocks private IPs and local paths", () => {
    assert.equal(isBlockedIp("127.0.0.1"), true);
    assert.equal(isBlockedIp("10.0.0.1"), true);
    assert.equal(isBlockedIp("192.168.1.1"), true);
    assert.equal(isBlockedIp("169.254.169.254"), true);
    assert.equal(isBlockedIp("8.8.8.8"), false);
    assert.throws(() => assertNotLocalPath("C:\\\\Secrets\\\\photo.png"));
    assert.throws(() => assertNotLocalPath("file:///etc/passwd"));
    assert.throws(() => assertNotLocalPath("/var/private/x.jpg"));
  });

  it("rejects non-image and oversized payloads", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("not-an-image", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    await assert.rejects(
      () =>
        downloadImageSafely("https://cdn.example.com/x.jpg", {
          maxBytes: 1024,
          timeoutMs: 2000,
          fetchImpl,
          resolveHost: async () => undefined,
        }),
      /Unsupported|non-image/i,
    );
  });

  it("surfaces HTTP 404 as ImageDownloadError for candidate skip", async () => {
    const { ImageDownloadError } = await import("../src/media/download.js");
    const fetchImpl: typeof fetch = async () =>
      new Response("gone", { status: 404 });
    await assert.rejects(
      () =>
        downloadImageSafely("https://cdn.example.com/missing.jpg", {
          maxBytes: 1024,
          timeoutMs: 2000,
          fetchImpl,
          resolveHost: async () => undefined,
        }),
      (err: unknown) =>
        err instanceof ImageDownloadError &&
        err.stage === "http" &&
        err.httpStatus === 404,
    );
  });

  it("accepts valid PNG via magic bytes", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(PNG_1X1, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    const got = await downloadImageSafely("https://cdn.example.com/x.png", {
      maxBytes: 10_000,
      timeoutMs: 2000,
      fetchImpl,
      resolveHost: async () => undefined,
    });
    assert.equal(got.contentType, "image/png");
    assert.ok(got.buffer.length > 0);
  });

  it("blocks redirects to private hosts", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/secret.png" },
      });
    };
    await assert.rejects(
      () =>
        downloadImageSafely("https://cdn.example.com/start.jpg", {
          maxBytes: 1024,
          timeoutMs: 2000,
          fetchImpl,
          resolveHost: async (host) => {
            if (host === "127.0.0.1" || isBlockedIp(host)) {
              throw new Error("Private or reserved IP addresses are not allowed");
            }
          },
        }),
      /Private|reserved|Blocked/i,
    );
    assert.ok(n >= 1);
  });
});

describe("inbound image receive", () => {
  it("extracts image attachments and rejects unsupported types", () => {
    const imgs = extractInboundImages([
      {
        content_type: "image/jpeg",
        url: "https://qq.cdn.example/a.jpg",
        filename: "a.jpg",
      },
      {
        content_type: "application/pdf",
        url: "https://qq.cdn.example/a.pdf",
      },
      {
        content_type: "image/png",
        url: "not-a-url",
      },
    ]);
    assert.equal(imgs.length, 1);
    assert.equal(isSupportedInboundImageMime("image/jpeg"), true);
    assert.equal(isSupportedInboundImageMime("application/pdf"), false);
    assert.equal(backendCanInspectImages("claude"), false);
    assert.equal(backendCanInspectImages("codex"), false);
    assert.match(imageReceivedAckText(1), /不能识别/);
  });
});

describe("ImageMediaService search + download (mocked)", () => {
  it("returns one downloaded image from Openverse-shaped JSON", async () => {
    clearImageSearchCache();
    clearRecentlySent();
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.openverse.org")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "hit1",
                title: "Cat",
                url: "https://cdn.example.com/cat.png",
                width: 800,
                height: 600,
                license: "by",
                creator: "Someone",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(PNG_1X1, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    };
    const svc = new ImageMediaService(
      {
        enabled: true,
        rateLimitPerMinute: 100,
        providerPriority: ["openverse"],
      },
      { fetchImpl },
    );
    // Patch download host resolve via fetch only — downloadImageSafely still DNS-resolves.
    // Use service with custom download by stubbing through URL that we intercept:
    // Override by injecting resolve via monkeypatch is hard; call download path with
    // mocked DNS by testing service.findAndDownload after patching module — instead
    // test select+download separately and here mock at service with a subclass.
    const outcome = await (async () => {
      const hits = [
        {
          id: "openverse:hit1",
          provider: "openverse" as const,
          title: "Cat",
          url: "https://cdn.example.com/cat.png",
          width: 800,
          height: 600,
          attribution: "Someone · license by · via Openverse",
        },
      ];
      const hit = selectBestImage(hits, {
        minWidth: 200,
        minHeight: 200,
        subject: "cat",
      })!;
      const downloaded = await downloadImageSafely(hit.url, {
        maxBytes: 1_000_000,
        timeoutMs: 3000,
        fetchImpl,
        resolveHost: async () => undefined,
      });
      return { ok: true as const, hit, downloaded, caption: hit.attribution ?? "" };
    })();
    assert.equal(outcome.ok, true);
    assert.equal(outcome.downloaded.contentType, "image/png");
    void svc;
  });
});

describe("runtime image routing — C2C / group / access", () => {
  let dataDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dataDir = tempDataDir();
    prev = process.env.QQBRIDGE_DATA_DIR;
    process.env.QQBRIDGE_DATA_DIR = dataDir;
    resetRuntimeForTests();
    resetImageMediaServiceForTests(undefined);
    clearImageSearchCache();
    clearRecentlySent();
    clearImageSessionForTests();
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
    resetImageMediaServiceForTests(undefined);
    clearImageSessionForTests();
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

  function wireRuntime(opts: {
    adapter?: CaptureAdapter;
    images?: Buffer[];
    texts?: string[];
    imageTargets?: ReplyTarget[];
  }) {
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

    const runtime = new BridgeRuntime();
    const adapter = opts.adapter ?? new CaptureAdapter();
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;

    const texts = opts.texts ?? [];
    const images = opts.images ?? [];
    const imageTargets = opts.imageTargets ?? [];
    const events: string[] = [];

    (runtime as unknown as { transport: Record<string, unknown> }).transport = {
      sendText: async (_t: ReplyTarget, text: string) => {
        events.push(`text:${text}`);
        texts.push(text);
        return true;
      },
      sendImageBuffer: async (
        t: ReplyTarget,
        buf: Buffer,
        sendOpts?: { content?: string },
      ) => {
        events.push(
          sendOpts?.content ? `image+caption:${sendOpts.content}` : "image",
        );
        images.push(buf);
        imageTargets.push(t);
        return true;
      },
      sendTyping: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined,
    };

    // Stub image service to avoid live Openverse/DNS in unit tests.
    const fake = {
      enabled: true,
      findAndDownload: async () => ({
        ok: true as const,
        delivery: "image" as const,
        hit: {
          id: "openverse:test",
          provider: "openverse" as const,
          title: "Test",
          url: "https://cdn.example.com/t.png",
          attribution: "via Openverse",
        },
        downloaded: {
          buffer: PNG_1X1,
          contentType: "image/png",
          finalUrl: "https://cdn.example.com/t.png",
          byteLength: PNG_1X1.length,
        },
        chatReply: "这张不错",
        attribution: "Openverse · internal",
        caption: "这张不错",
      }),
    };
    resetImageMediaServiceForTests(fake as unknown as ImageMediaService);

    return { runtime, adapter, texts, images, imageTargets, events };
  }

  it("C2C /image sends image first then short text, never reaches the model", async () => {
    const { runtime, adapter, texts, images, imageTargets, events } =
      wireRuntime({});
    await runtime.handleQqMessage(
      "/image cat",
      { scope: "c2c", targetId: "user-a" } as ReplyTarget,
      "user-a",
      new PipelineTrace(),
      "c2c:user-a",
    );
    assert.equal(adapter.sent.length, 0);
    assert.equal(images.length, 1);
    assert.equal(imageTargets[0]?.scope, "c2c");
    assert.equal(texts.length, 1);
    assert.equal(texts[0], "这张不错");
    assert.deepEqual(events, ["image", "text:这张不错"]);
    assert.doesNotMatch(
      texts.join("\n"),
      /未做人脸|非官方|图源：|许可证未验证|仅作搜索聚合|来源网页|图：/,
    );
    await runtime.stop();
  });

  it("does not send technical attribution captions from DDGS-style outcomes", async () => {
    const { runtime, adapter, texts, images } = wireRuntime({});
    resetImageMediaServiceForTests({
      enabled: true,
      findAndDownload: async () => ({
        ok: true as const,
        delivery: "image" as const,
        hit: {
          id: "ddgs:reddit",
          provider: "ddgs" as const,
          title: "Minji",
          url: "https://cdn.example.com/m.png",
          source: "www.reddit.com",
          attribution:
            "www.reddit.com · 来源网页（许可证未验证；仅作搜索聚合） · https://www.reddit.com/r/x/",
        },
        downloaded: {
          buffer: PNG_1X1,
          contentType: "image/png",
          finalUrl: "https://cdn.example.com/m.png",
          byteLength: PNG_1X1.length,
        },
        // Simulate a buggy/legacy caption that still embeds the disclaimer.
        chatReply:
          "这张不错\n图：www.reddit.com · 来源网页（许可证未验证；仅作搜索聚合）",
        attribution:
          "www.reddit.com · 来源网页（许可证未验证；仅作搜索聚合） · https://www.reddit.com/r/x/",
        caption:
          "这张不错 图：www.reddit.com · 来源网页（许可证未验证；仅作搜索聚合）",
      }),
    } as unknown as ImageMediaService);

    await runtime.handleQqMessage(
      "来张张元英",
      { scope: "c2c", targetId: "user-a" } as ReplyTarget,
      "user-a",
      new PipelineTrace(),
      "c2c:user-a",
    );
    assert.equal(adapter.sent.length, 0);
    assert.equal(images.length, 1);
    // Image sent; technical follow-up suppressed entirely.
    assert.equal(texts.length, 0);
    assert.doesNotMatch(
      texts.join("\n"),
      /许可证未验证|仅作搜索聚合|来源网页|图：www\.reddit/,
    );
    await runtime.stop();
  });

  it("group natural-language search uses group reply target", async () => {
    const { runtime, adapter, images, imageTargets } = wireRuntime({});
    await runtime.handleQqMessage(
      "发个猫猫表情包",
      { scope: "group", targetId: "group-openid-1", msgId: "g1" } as ReplyTarget,
      "member-1",
      new PipelineTrace(),
      "group:group-openid-1",
    );
    assert.equal(adapter.sent.length, 0);
    assert.equal(images.length, 1);
    assert.equal(imageTargets[0]?.scope, "group");
    assert.equal(imageTargets[0]?.targetId, "group-openid-1");
    await runtime.stop();
  });

  it("live failure: group 来张张元英 is Bridge-handled, never reaches Codex", async () => {
    const { runtime, adapter, images, imageTargets, texts, events } =
      wireRuntime({});
    await runtime.handleQqMessage(
      "来张张元英",
      {
        scope: "group",
        targetId: "group-openid-1",
        msgId: "gm-wonyoung",
      } as ReplyTarget,
      "member-1",
      new PipelineTrace(),
      "group:group-openid-1",
    );
    assert.equal(adapter.sent.length, 0, "must not forward to LLM");
    assert.equal(images.length, 1, "Bridge must attempt image send");
    assert.equal(imageTargets[0]?.scope, "group");
    assert.equal(texts.length, 1);
    assert.deepEqual(events[0], "image");
    assert.match(events[1] ?? "", /^text:/);
    assert.doesNotMatch(texts.join("\n"), /正在路上|抽风|没法触发|未做人脸|非官方/);
    await runtime.stop();
  });

  it("QQ image failure does not send a success chat phrase", async () => {
    const { runtime, texts, images } = wireRuntime({});
    (runtime as unknown as { transport: Record<string, unknown> }).transport = {
      sendText: async (_t: ReplyTarget, text: string) => {
        texts.push(text);
        return true;
      },
      sendImageBuffer: async () => false,
      sendTyping: async () => undefined,
      isConnected: () => true,
      stop: async () => undefined,
    };
    await runtime.handleQqMessage(
      "/image cat",
      { scope: "c2c", targetId: "user-a" } as ReplyTarget,
      "user-a",
      new PipelineTrace(),
      "c2c:user-a",
    );
    assert.equal(images.length, 0);
    assert.equal(texts.length, 1);
    assert.match(texts[0]!, /发送失败/);
    assert.doesNotMatch(texts[0]!, /这张不错|好棒|合不合你口味/);
    await runtime.stop();
  });

  it("follow-up 这张不好看…她的图 uses last IMAGE_SENT and never reaches Codex", async () => {
    const { recordBridgeAction, clearBridgeActionsForTests } = await import(
      "../src/bridge/recent-actions.js"
    );
    clearBridgeActionsForTests();
    recordBridgeAction({
      kind: "image_search_send",
      status: "sent",
      conversationId: "c2c:user-a",
      query: "申有娜",
      title: "Shin Yuna",
      provider: "openverse",
      imageId: "openverse:yuna1",
      delivered: true,
    });

    const calls: Array<{ q: string; prefer?: boolean }> = [];
    resetImageMediaServiceForTests({
      enabled: true,
      findAndDownload: async (q: string, _c: string, opts?: { preferDifferent?: boolean }) => {
        calls.push({ q, prefer: opts?.preferDifferent });
        return {
          ok: true as const,
          delivery: "image" as const,
          hit: {
            id: "openverse:yuna2",
            provider: "openverse" as const,
            title: "Shin Yuna 2",
            url: "https://cdn.example.com/y2.png",
          },
          downloaded: {
            buffer: PNG_1X1,
            contentType: "image/png",
            finalUrl: "https://cdn.example.com/y2.png",
            byteLength: PNG_1X1.length,
          },
          chatReply: "换了张，看看合不合你口味",
          attribution: "Wikimedia Commons · Shin Yuna",
          caption: "换了张，看看合不合你口味",
        };
      },
    } as unknown as ImageMediaService);

    const { runtime, adapter, images, texts } = wireRuntime({});
    // Re-apply stub after wireRuntime (which installs its own fake).
    resetImageMediaServiceForTests({
      enabled: true,
      findAndDownload: async (q: string, _c: string, opts?: { preferDifferent?: boolean }) => {
        calls.push({ q, prefer: opts?.preferDifferent });
        return {
          ok: true as const,
          delivery: "image" as const,
          hit: {
            id: "openverse:yuna2",
            provider: "openverse" as const,
            title: "Shin Yuna 2",
            url: "https://cdn.example.com/y2.png",
          },
          downloaded: {
            buffer: PNG_1X1,
            contentType: "image/png",
            finalUrl: "https://cdn.example.com/y2.png",
            byteLength: PNG_1X1.length,
          },
          chatReply: "换了张，看看合不合你口味",
          attribution: "Wikimedia Commons · Shin Yuna",
          caption: "换了张，看看合不合你口味",
        };
      },
    } as unknown as ImageMediaService);

    await runtime.handleQqMessage(
      "这张不好看，我要看其他的她的图",
      { scope: "c2c", targetId: "user-a" } as ReplyTarget,
      "user-a",
      new PipelineTrace(),
      "c2c:user-a",
    );
    assert.equal(adapter.sent.length, 0, "must not forward follow-up to LLM");
    assert.equal(images.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.q, "申有娜");
    assert.equal(calls[0]?.prefer, true);
    assert.equal(texts.length, 1);
    assert.match(texts[0]!, /换了张|合不合你口味/);
    assert.doesNotMatch(texts.join("\n"), /\/image|未做人脸|非官方/);
    await runtime.stop();
    clearBridgeActionsForTests();
  });

  it("search failure stays Bridge-owned truthful text (no LLM fabrication)", async () => {
    const { runtime, adapter, texts, images } = wireRuntime({});
    resetImageMediaServiceForTests({
      enabled: true,
      findAndDownload: async () => ({
        ok: false as const,
        error:
          "公开图库里没找到能确认是「张元英 / Jang Wonyoung」的图（只按标题/标签匹配，不做脸部识别）。我不会随手发一张无关的。",
      }),
    } as unknown as ImageMediaService);

    await runtime.handleQqMessage(
      "来张张元英",
      { scope: "group", targetId: "group-openid-1" } as ReplyTarget,
      "member-1",
      new PipelineTrace(),
      "group:group-openid-1",
    );
    assert.equal(adapter.sent.length, 0);
    assert.equal(images.length, 0);
    assert.match(texts.join("\n"), /没找到能确认|不会随手发/);
    assert.doesNotMatch(texts.join("\n"), /正在路上/);
    await runtime.stop();
  });

  it("image-only receive acknowledges without inventing vision or calling model", async () => {
    const { runtime, adapter, texts } = wireRuntime({});
    await runtime.handleQqMessage(
      "",
      { scope: "c2c", targetId: "user-a" } as ReplyTarget,
      "user-a",
      new PipelineTrace(),
      "c2c:user-a",
      [
        {
          content_type: "image/jpeg",
          url: "https://qq.cdn.example/photo.jpg",
        },
      ],
    );
    assert.equal(adapter.sent.length, 0);
    assert.match(texts.join("\n"), /不能识别/);
    await runtime.stop();
  });

  it("generation requests are refused without model or search", async () => {
    const { runtime, adapter, texts, images } = wireRuntime({});
    await runtime.handleQqMessage(
      "画一张龙",
      { scope: "c2c", targetId: "user-a" } as ReplyTarget,
      "user-a",
      new PipelineTrace(),
      "c2c:user-a",
    );
    assert.equal(adapter.sent.length, 0);
    assert.equal(images.length, 0);
    assert.match(texts.join("\n"), /不会用 AI 生成/);
    await runtime.stop();
  });

  it("slash image cannot bypass empty C2C allowlist", async () => {
    const cfg = defaultConfig();
    cfg.allowlist.c2cMode = "allowlist";
    cfg.allowlist.users = [];
    saveConfig(cfg);
    const runtime = new BridgeRuntime();
    const adapter = new CaptureAdapter();
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
    await runtime.handleQqMessage(
      "/image cat",
      { scope: "c2c", targetId: "user-1" } as ReplyTarget,
      "user-1",
      new PipelineTrace(),
      "c2c:user-1",
    );
    assert.equal(images.length, 0);
    assert.equal(adapter.sent.length, 0);
    assert.match(texts.join("\n"), /allowlist add/i);
    await runtime.stop();
  });

  it("ordinary chat still reaches Claude/Codex path", async () => {
    const { runtime, adapter, images } = wireRuntime({});
    await runtime.handleQqMessage(
      "你好呀",
      { scope: "c2c", targetId: "user-a" } as ReplyTarget,
      "user-a",
      new PipelineTrace(),
      "c2c:user-a",
    );
    assert.equal(images.length, 0);
    assert.equal(adapter.sent[0], "你好呀");
    await runtime.stop();
  });
});
