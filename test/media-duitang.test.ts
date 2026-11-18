import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDuitangQueries,
  clearImageSearchCache,
  clearRecentlySent,
  createImageProviders,
  DuitangImageProvider,
  enabledProviderIds,
  formatDuitangLinkCaption,
  ImageMediaService,
  mapDuitangObject,
  parseImageIntent,
  recentlySentIds,
  resetImageMediaServiceForTests,
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
import { describeGroupAccessPolicy } from "../src/qq/access.js";

/** Minimal valid 1x1 PNG (same as media-images tests). */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const SAMPLE_OBJECT = {
  id: 123456789,
  msg: "张元英 IVE 舞台直拍",
  sender_id: 42,
  photo: {
    id: 99,
    width: 1200,
    height: 1600,
    path: "https://a-ho-img.dtstatic.com/example/wonyoung.jpg",
  },
  tags: ["张元英", "IVE", { name: "直拍" }],
};

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-duitang-"));
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
    return "sess-dt";
  }
  async send(message: string): Promise<void> {
    await this.sendAndCollect(message, "sess-dt");
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

describe("duitang response parsing", () => {
  it("maps blog object into ImageSearchHit schema", () => {
    const hit = mapDuitangObject(SAMPLE_OBJECT);
    assert.ok(hit);
    assert.equal(hit!.id, "duitang:123456789");
    assert.equal(hit!.provider, "duitang");
    assert.equal(hit!.source, "duitang");
    assert.equal(hit!.title, "张元英 IVE 舞台直拍");
    assert.equal(
      hit!.url,
      "https://a-ho-img.dtstatic.com/example/wonyoung.jpg",
    );
    assert.equal(hit!.width, 1200);
    assert.equal(hit!.height, 1600);
    assert.equal(hit!.creator, "用户42");
    assert.equal(
      hit!.foreignLandingUrl,
      "https://www.duitang.com/blog/?id=123456789",
    );
    assert.ok(hit!.tags?.includes("张元英"));
    assert.ok(hit!.tags?.includes("直拍"));
  });

  it("rejects non-HTTPS or missing photo path", () => {
    assert.equal(
      mapDuitangObject({
        id: 1,
        photo: { path: "http://insecure.example/x.jpg" },
      }),
      undefined,
    );
    assert.equal(mapDuitangObject({ id: 1, photo: {} }), undefined);
    assert.equal(
      mapDuitangObject({
        photo: { path: "https://a-ho-img.dtstatic.com/x.jpg" },
      }),
      undefined,
    );
  });

  it("provider search parses JSON and Chinese K-pop kw", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      assert.match(url, /duitang\.com\/napi\/blog\/list\/by_search/);
      assert.match(url, /kw=%E7%94%B3%E6%9C%89%E5%A8%9C|kw=申有娜/);
      return Response.json({
        status: 1,
        data: {
          total: 1,
          object_list: [
            {
              id: 777,
              msg: "申有娜 ITZY",
              photo: {
                width: 800,
                height: 1000,
                path: "https://c-ssl.dtstatic.com/yuna.jpg",
              },
            },
          ],
        },
      });
    };
    const p = new DuitangImageProvider(fetchImpl);
    const hits = await p.search({
      queries: ["申有娜"],
      pageSize: 8,
      timeoutMs: 3000,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.id, "duitang:777");
    assert.match(hits[0]!.title ?? "", /申有娜/);
    assert.ok(seen.length >= 1);
  });

  it("buildDuitangQueries prefers Chinese aliases first", () => {
    const qs = buildDuitangQueries({
      subject: "张元英",
      aliases: ["张元英", "jang wonyoung", "장원영", "IVE"],
      englishQueries: ["Jang Wonyoung IVE"],
    });
    assert.equal(qs[0], "张元英");
    assert.ok(qs.includes("jang wonyoung") || qs.includes("Jang Wonyoung IVE"));
  });
});

describe("duitang provider registry + delivery modes", () => {
  beforeEach(() => {
    clearImageSearchCache();
    clearRecentlySent();
  });

  it("duitang is off by default in provider list", () => {
    const providers = createImageProviders({ ddgsEnabled: false });
    assert.equal(
      providers.some((p) => p.id === "duitang"),
      false,
    );
    // DDGS-only default: no silent Openverse when DDGS is off / not listed.
    assert.equal(providers.some((p) => p.id === "openverse"), false);
    assert.deepEqual(enabledProviderIds({ ddgs: { enabled: false } }), []);
    // Explicit Openverse pin / priority still works.
    assert.ok(
      enabledProviderIds({
        ddgs: { enabled: false },
        providerPriority: ["openverse"],
      }).includes("openverse"),
    );
  });

  it("enables duitang when configured", () => {
    const providers = createImageProviders({
      ddgsEnabled: false,
      duitangEnabled: true,
      priority: ["duitang", "openverse"],
    });
    assert.equal(providers[0]?.id, "duitang");
    assert.ok(providers.some((p) => p.id === "openverse"));
    assert.deepEqual(
      enabledProviderIds({
        ddgs: { enabled: false },
        duitang: { enabled: true },
        providerPriority: ["duitang", "openverse"],
      }),
      ["duitang", "openverse"],
    );
  });

  it("link delivery (default) sends caption without downloading CDN bytes", async () => {
    const fetched: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url.includes("duitang.com/napi")) {
        return Response.json({
          status: 1,
          data: {
            object_list: [SAMPLE_OBJECT],
          },
        });
      }
      // Openverse should not be required when Duitang returns enough.
      if (url.includes("api.openverse.org")) {
        return Response.json({ results: [] });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const svc = new ImageMediaService(
      {
        enabled: true,
        rateLimitPerMinute: 100,
        providerPriority: ["duitang"],
        duitang: { enabled: true, deliveryMode: "link" },
      },
      { fetchImpl, resolveHost: async () => undefined },
    );
    const got = await svc.findAndDownload("张元英", "c2c:dt-link");
    assert.equal(got.ok, true);
    if (got.ok) {
      assert.equal(got.delivery, "link");
      assert.equal(got.hit.provider, "duitang");
      assert.match(got.caption, /来源链接|blog\/\?id=123456789/);
      assert.doesNotMatch(got.caption, /未做人脸|非官方/);
      assert.equal("downloaded" in got && !!(got as { downloaded?: unknown }).downloaded, false);
    }
    assert.equal(
      fetched.some((u) => u.includes("dtstatic.com")),
      false,
      "must not download CDN bytes in link mode",
    );
    assert.ok(recentlySentIds("c2c:dt-link").has("duitang:123456789"));
  });

  it("image delivery mode downloads CDN through safe downloader", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("duitang.com/napi")) {
        return Response.json({
          status: 1,
          data: { object_list: [SAMPLE_OBJECT] },
        });
      }
      if (url.includes("dtstatic.com")) {
        return new Response(PNG_1X1, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("api.openverse.org")) {
        return Response.json({ results: [] });
      }
      return new Response("nope", { status: 404 });
    };

    const svc = new ImageMediaService(
      {
        enabled: true,
        rateLimitPerMinute: 100,
        providerPriority: ["duitang"],
        duitang: { enabled: true, deliveryMode: "image" },
      },
      { fetchImpl, resolveHost: async () => undefined },
    );
    const got = await svc.findAndDownload("张元英", "c2c:dt-img");
    assert.equal(got.ok, true);
    if (got.ok) {
      assert.equal(got.delivery, "image");
      assert.ok(got.downloaded);
      assert.equal(got.downloaded!.byteLength, PNG_1X1.length);
      assert.match(got.chatReply, /这张|看看|好棒|发你|换/);
      assert.doesNotMatch(got.chatReply, /未做人脸|非官方|署名\+非商业/);
      assert.match(got.attribution, /堆糖/);
    }
  });

  it("dedupes previously sent duitang ids on preferDifferent", async () => {
    let page = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("duitang.com/napi")) {
        page += 1;
        const id = page === 1 ? 111 : 222;
        return Response.json({
          status: 1,
          data: {
            object_list: [
              {
                id,
                msg: "张元英",
                photo: {
                  width: 900,
                  height: 1200,
                  path: `https://a-ho-img.dtstatic.com/w${id}.jpg`,
                },
              },
            ],
          },
        });
      }
      if (url.includes("api.openverse.org")) {
        return Response.json({ results: [] });
      }
      return new Response("nope", { status: 404 });
    };

    const svc = new ImageMediaService(
      {
        enabled: true,
        rateLimitPerMinute: 100,
        providerPriority: ["duitang"],
        duitang: { enabled: true, deliveryMode: "link" },
      },
      { fetchImpl, resolveHost: async () => undefined },
    );
    const first = await svc.findAndDownload("张元英", "c2c:dt-dedupe");
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.hit.id, "duitang:111");

    clearImageSearchCache();
    const second = await svc.findAndDownload("张元英", "c2c:dt-dedupe", {
      preferDifferent: true,
    });
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.hit.id, "duitang:222");
      assert.notEqual(second.hit.id, "duitang:111");
    }
  });

  it("rate-limits repeated searches", async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({ status: 1, data: { object_list: [] } });
    const svc = new ImageMediaService(
      {
        enabled: true,
        rateLimitPerMinute: 1,
        duitang: { enabled: true },
      },
      { fetchImpl, resolveHost: async () => undefined },
    );
    await svc.findAndDownload("猫", "c2c:rl");
    const second = await svc.findAndDownload("猫", "c2c:rl");
    assert.equal(second.ok, false);
    if (!second.ok) assert.match(second.error, /频繁/);
  });

  it("provider failure falls back without inventing hits", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("duitang.com")) {
        return new Response("boom", { status: 503 });
      }
      if (url.includes("api.openverse.org")) {
        return Response.json({
          results: [
            {
              id: "ov1",
              title: "Jang Wonyoung IVE",
              url: "https://cdn.example.com/ov.png",
              width: 800,
              height: 1000,
              source: "wikimedia",
              license: "by",
              creator: "test",
            },
          ],
        });
      }
      if (url.includes("cdn.example.com")) {
        return new Response(PNG_1X1, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("nope", { status: 404 });
    };
    const svc = new ImageMediaService(
      {
        enabled: true,
        rateLimitPerMinute: 100,
        // Explicit multi-provider opt-in (not the DDGS-only default).
        providerPriority: ["duitang", "openverse"],
        autoFallback: false,
        duitang: { enabled: true, deliveryMode: "link" },
      },
      { fetchImpl, resolveHost: async () => undefined },
    );
    const got = await svc.findAndDownload("张元英", "c2c:fallback");
    assert.equal(got.ok, true);
    if (got.ok) {
      assert.equal(got.hit.provider, "openverse");
      assert.equal(got.delivery, "image");
    }
  });

  it("formatDuitangLinkCaption stays short and honest", () => {
    const hit = mapDuitangObject(SAMPLE_OBJECT)!;
    const cap = formatDuitangLinkCaption(hit);
    assert.match(cap, /来源链接|blog/);
    assert.doesNotMatch(cap, /未做人脸|非官方|开放 API/);
  });
});

describe("duitang QQ private + group delivery (allowlist)", () => {
  let dataDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dataDir = tempDataDir();
    prev = process.env.QQBRIDGE_DATA_DIR;
    process.env.QQBRIDGE_DATA_DIR = dataDir;
    resetRuntimeForTests();
    resetImageMediaServiceForTests(undefined);
    resetMemoryManagerForTests(
      new MemoryManager({
        store: new MemoryStore(":memory:"),
        config: { enabled: true },
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

  function wire(opts: {
    groups?: string[];
    groupMode?: "allowlist" | "open" | "disabled";
  } = {}) {
    const cfg = defaultConfig();
    cfg.allowlist.c2cMode = "open";
    cfg.allowlist.groupMode = opts.groupMode ?? "allowlist";
    cfg.allowlist.groups = opts.groups ?? ["group-openid-1"];
    cfg.bridge.requireApprovalForDangerous = false;
    cfg.bridge.images = {
      enabled: true,
      rateLimitPerMinute: 100,
      duitang: { enabled: true, deliveryMode: "link" },
    };
    saveConfig(cfg);

    const runtime = new BridgeRuntime();
    const adapter = new CaptureAdapter();
    (runtime as unknown as { adapter: AgentAdapter }).adapter = adapter;
    const texts: string[] = [];
    const images: Buffer[] = [];
    const imageTargets: ReplyTarget[] = [];
    (runtime as unknown as { transport: Record<string, unknown> }).transport = {
      sendText: async (_t: ReplyTarget, text: string) => {
        texts.push(text);
        return true;
      },
      sendImageBuffer: async (t: ReplyTarget, buf: Buffer) => {
        images.push(buf);
        imageTargets.push(t);
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
        delivery: "link" as const,
        hit: {
          id: "duitang:999",
          provider: "duitang" as const,
          title: "张元英",
          url: "https://a-ho-img.dtstatic.com/x.jpg",
          foreignLandingUrl: "https://www.duitang.com/blog/?id=999",
          source: "duitang",
        },
        caption: formatDuitangLinkCaption({
          id: "duitang:999",
          provider: "duitang",
          title: "张元英",
          url: "https://a-ho-img.dtstatic.com/x.jpg",
          foreignLandingUrl: "https://www.duitang.com/blog/?id=999",
          source: "duitang",
        }),
      }),
    } as unknown as ImageMediaService);

    return { runtime, adapter, texts, images, imageTargets, cfg };
  }

  it("C2C natural search delivers Duitang link text, not model turn", async () => {
    const { runtime, adapter, texts, images } = wire();
    await runtime.handleQqMessage(
      "来张张元英",
      { scope: "c2c", targetId: "user-a" } as ReplyTarget,
      "user-a",
      new PipelineTrace(),
      "c2c:user-a",
    );
    assert.equal(adapter.sent.length, 0);
    assert.equal(images.length, 0);
    assert.equal(texts.length, 1);
    assert.match(texts[0]!, /堆糖|来源/);
    await runtime.stop();
  });

  it("allowlisted group @mention-normalized 来张张元英 gets link reply", async () => {
    const { runtime, adapter, texts, images, imageTargets } = wire();
    await runtime.handleQqMessage(
      "来张张元英",
      {
        scope: "group",
        targetId: "group-openid-1",
        msgId: "g-dt-1",
      } as ReplyTarget,
      "member-1",
      new PipelineTrace(),
      "group:group-openid-1",
    );
    assert.equal(adapter.sent.length, 0);
    assert.equal(images.length, 0);
    assert.equal(texts.length, 1);
    assert.match(texts[0]!, /blog\/\?id=999|堆糖/);
    assert.equal(imageTargets.length, 0);
    await runtime.stop();
  });

  it("group /image 申有娜 uses Bridge path", async () => {
    const { runtime, adapter, texts } = wire();
    await runtime.handleQqMessage(
      "/image 申有娜",
      {
        scope: "group",
        targetId: "group-openid-1",
        msgId: "g-dt-2",
      } as ReplyTarget,
      "member-1",
      new PipelineTrace(),
      "group:group-openid-1",
    );
    assert.equal(adapter.sent.length, 0);
    assert.equal(texts.length, 1);
    await runtime.stop();
  });

  it("unauthorized / empty group allowlist policy blocks reception", () => {
    const cfg = defaultConfig();
    cfg.allowlist.groupMode = "allowlist";
    cfg.allowlist.groups = [];
    const policy = describeGroupAccessPolicy(cfg);
    assert.equal(policy.willReceiveGroupAt, false);
    assert.match(policy.startupWarning ?? "", /add-group/);
  });

  it("conversation isolation: group A sent ids do not leak to group B", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("duitang.com/napi")) {
        return Response.json({
          status: 1,
          data: {
            object_list: [
              {
                id: 501,
                msg: "张元英",
                photo: {
                  width: 800,
                  height: 1000,
                  path: "https://a-ho-img.dtstatic.com/a.jpg",
                },
              },
              {
                id: 502,
                msg: "张元英 写真",
                photo: {
                  width: 900,
                  height: 1100,
                  path: "https://a-ho-img.dtstatic.com/b.jpg",
                },
              },
            ],
          },
        });
      }
      return Response.json({ results: [] });
    };
    const svc = new ImageMediaService(
      {
        enabled: true,
        rateLimitPerMinute: 100,
        providerPriority: ["duitang"],
        duitang: { enabled: true, deliveryMode: "link" },
      },
      { fetchImpl, resolveHost: async () => undefined },
    );
    const a = await svc.findAndDownload("张元英", "group:A");
    assert.equal(a.ok, true);
    if (!a.ok) return;
    const sentA = a.hit.id;
    assert.match(sentA, /^duitang:/);
    assert.ok(recentlySentIds("group:A").has(sentA));
    assert.equal(
      recentlySentIds("group:B").has(sentA),
      false,
      "group B must not inherit group A recent-sent",
    );

    const b = await svc.findAndDownload("张元英", "group:B");
    assert.equal(b.ok, true);
    if (b.ok) {
      // B may reuse the same top hit — history is per-conversation.
      assert.match(b.hit.id, /^duitang:/);
    }
  });

  it("follow-up intents still resolve with last query", () => {
    assert.deepEqual(
      parseImageIntent("换一张", { lastImageQuery: "张元英" }),
      { kind: "search", query: "张元英", preferDifferent: true },
    );
    assert.deepEqual(
      parseImageIntent("再来张她的", { lastImageQuery: "申有娜" }),
      { kind: "search", query: "申有娜", preferDifferent: true },
    );
    assert.deepEqual(
      parseImageIntent("有没有别的", { lastImageQuery: "张元英" }),
      { kind: "search", query: "张元英", preferDifferent: true },
    );
  });
});
