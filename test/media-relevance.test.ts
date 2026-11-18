import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearDeadImages,
  clearImageSearchCache,
  clearRecentlySent,
  containsTechnicalAttributionText,
  formatChatImageFollowUp,
  formatInternalImageAttribution,
  formatLicenseLabel,
  formatMinimalVisibleCredit,
  ImageDownloadError,
  isUnverifiedLicenseDisclaimer,
  requiresVisibleAttribution,
  resetImageChatReplyCursorForTests,
  ImageMediaService,
  isDeadImage,
  isRetryableImageDownloadError,
  listRelevantImages,
  mapDdgsResult,
  mapSearxngResult,
  matchImageEntity,
  normalizeImageSearchQuery,
  parseImageIntent,
  pickRelevantImage,
  rememberDeadImage,
  rememberSentImage,
  stripImageQueryFillers,
} from "../src/media/index.js";
import type { ImageSearchHit } from "../src/media/types.js";

/** Minimal valid 1x1 PNG */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function hit(partial: Partial<ImageSearchHit> & { id: string; url: string }): ImageSearchHit {
  return {
    provider: "openverse",
    width: 800,
    height: 1000,
    ...partial,
  };
}

describe("entity-aware query normalization", () => {
  it("maps 张元英 / 申有娜 to romanized search queries", () => {
    assert.equal(stripImageQueryFillers("张元英美图"), "张元英");
    const w = normalizeImageSearchQuery("张元英美图");
    assert.equal(w.entity?.id, "jang-wonyoung");
    assert.ok(w.searchQueries.some((q) => /wonyoung/i.test(q)));
    assert.equal(w.requireStrongEvidence, true);

    const y = normalizeImageSearchQuery("申有娜");
    assert.equal(y.entity?.id, "shin-yuna");
    assert.ok(y.searchQueries.some((q) => /yuna|신유나|ITZY/i.test(q)));
    assert.ok(matchImageEntity("Shin Yuna"));
  });

  it("parses 来张张元英 / 来张张元英美图 into search subject 张元英", () => {
    for (const phrase of ["来张张元英", "来张张元英美图", "找张张元英的图"] as const) {
      const intent = parseImageIntent(phrase);
      assert.equal(intent.kind, "search", phrase);
      if (intent.kind === "search") assert.equal(intent.query, "张元英", phrase);
    }
  });

  it("parses 有没有其他的 / 再来一张 as same subject with preferDifferent", () => {
    for (const phrase of [
      "有没有其他的张元英图",
      "再来一张张元英",
      "换一张张元英",
      "还有别的张元英图",
    ] as const) {
      const intent = parseImageIntent(phrase);
      assert.equal(intent.kind, "search", phrase);
      if (intent.kind === "search") {
        assert.equal(intent.query, "张元英", phrase);
        assert.equal(intent.preferDifferent, true, phrase);
      }
    }
    assert.equal(stripImageQueryFillers("有没有其他的张元英"), "张元英");
  });

  it("resolves 这张/她 follow-ups from last Bridge image query", () => {
    const ctx = { lastImageQuery: "申有娜" };
    for (const phrase of [
      "这张不好看，我要看其他的她的图",
      "我要看其他的她的图",
      "换一张",
      "再来一张",
      "还有别的吗",
      "其他的她的图",
    ] as const) {
      const intent = parseImageIntent(phrase, ctx);
      assert.equal(intent.kind, "search", phrase);
      if (intent.kind === "search") {
        assert.equal(intent.query, "申有娜", phrase);
        assert.equal(intent.preferDifferent, true, phrase);
      }
    }
    // Without recent image context, stay conservative (do not invent a subject).
    assert.equal(parseImageIntent("这张不好看，我要看其他的她的图").kind, "none");
    assert.equal(parseImageIntent("换一张").kind, "none");
  });
});

describe("idol relevance gating", () => {
  it("rejects unrelated parade / IMG_4617 for 张元英", () => {
    const parade = hit({
      id: "parade",
      url: "https://cdn.example.com/parade.jpg",
      title: "IMG_4617",
      creator: "chineseinus.org",
      source: "flickr",
      tags: ["chinatown", "parade"],
    });
    const wonyoung = hit({
      id: "wy",
      url: "https://cdn.example.com/wy.jpg",
      title: "장원영 (JANG WONYOUNG) - RIMOWA - 2023.05.13 P1",
      creator: "티비텐",
      source: "wikimedia",
    });
    const entity = matchImageEntity("张元英")!;
    const picked = pickRelevantImage([parade, wonyoung], {
      subject: "张元英",
      entity,
      requireStrongEvidence: true,
      minWidth: 200,
      minHeight: 200,
    });
    assert.equal(picked?.hit.id, "wy");

    const onlyParade = pickRelevantImage([parade], {
      subject: "张元英",
      entity,
      requireStrongEvidence: true,
      minWidth: 200,
      minHeight: 200,
    });
    assert.equal(onlyParade, undefined);
  });

  it("does not match 申有娜 to generic Chinese Flickr noise", () => {
    const noise = hit({
      id: "noise",
      url: "https://cdn.example.com/noise.jpg",
      title: "DING XIAOYI－ACTION STILLS",
      tags: ["tvseries", "丁笑宜", "张笑天"],
      source: "flickr",
    });
    const yuna = hit({
      id: "yuna",
      url: "https://cdn.example.com/yuna.jpg",
      title: "251110 Shin Yuna from ITZY",
      creator: "티비텐 TV10",
      source: "wikimedia",
    });
    const entity = matchImageEntity("申有娜")!;
    assert.equal(
      pickRelevantImage([noise], {
        subject: "申有娜",
        entity,
        requireStrongEvidence: true,
        minWidth: 200,
        minHeight: 200,
      }),
      undefined,
    );
    assert.equal(
      pickRelevantImage([noise, yuna], {
        subject: "申有娜",
        entity,
        requireStrongEvidence: true,
        minWidth: 200,
        minHeight: 200,
      })?.hit.id,
      "yuna",
    );
  });

  it("still selects topical /image cat results", () => {
    const dog = hit({
      id: "dog",
      url: "https://cdn.example.com/dog.jpg",
      title: "happy dog",
      tags: ["dog"],
    });
    const cat = hit({
      id: "cat",
      url: "https://cdn.example.com/cat.jpg",
      title: "Cat bliss",
      tags: ["cat", "pets"],
    });
    const picked = pickRelevantImage([dog, cat], {
      subject: "cat",
      requireStrongEvidence: false,
      minWidth: 200,
      minHeight: 200,
    });
    assert.equal(picked?.hit.id, "cat");
  });

  it("returns no image when nothing is relevant", () => {
    const junk = hit({
      id: "junk",
      url: "https://cdn.example.com/junk.jpg",
      title: "IMG_0908",
      source: "flickr",
    });
    assert.equal(
      pickRelevantImage([junk], {
        subject: "cat",
        requireStrongEvidence: false,
        minWidth: 200,
        minHeight: 200,
      }),
      undefined,
    );
  });
});

describe("QQ attribution", () => {
  it("keeps creator/license/link internally; chat reply stays casual", () => {
    assert.equal(formatLicenseLabel("by 4.0"), "CC BY 4.0");
    assert.equal(formatLicenseLabel("cc0"), "CC0");
    const h = hit({
      id: "wy",
      url: "https://cdn.example.com/wy.jpg",
      title:
        "장원영 (JANG WONYOUNG) - RIMOWA - 2023.05.13 P1 very long english korean dump",
      creator: "사진기자머길",
      license: "by 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      foreignLandingUrl: "https://commons.wikimedia.org/wiki/File:Example.jpg",
      source: "wikimedia",
    });
    const internal = formatInternalImageAttribution(h);
    assert.match(internal, /Wikimedia Commons/);
    assert.match(internal, /사진기자머길/);
    assert.match(internal, /CC BY 4\.0/);
    assert.match(internal, /commons\.wikimedia\.org/);
    assert.doesNotMatch(internal, /RIMOWA/);
    assert.doesNotMatch(internal, /未做人脸核验|非官方/);
    assert.ok(requiresVisibleAttribution(h));
    assert.match(formatMinimalVisibleCredit(h) ?? "", /사진기자머길.*CC BY 4\.0/);

    resetImageChatReplyCursorForTests();
    const chat = formatChatImageFollowUp(h);
    assert.match(chat, /这张不错|这张你看看|这个好棒|看看这张呢|发你一张|先看这张/);
    assert.match(chat, /图：사진기자머길 · CC BY 4\.0/);
    assert.doesNotMatch(chat, /未做人脸核验|非官方|open API/i);
    assert.ok(chat.length < 80);

    const cc0 = hit({
      id: "pd",
      url: "https://cdn.example.com/pd.jpg",
      license: "cc0",
      source: "wikimedia",
      creator: "NASA",
    });
    assert.equal(requiresVisibleAttribution(cc0), false);
    resetImageChatReplyCursorForTests();
    assert.equal(formatChatImageFollowUp(cc0), "这张不错");
  });

  it("never appends DDGS/SearXNG unverified license disclaimers to QQ chat", () => {
    // Legacy / defensive: disclaimer string must not become QQ credit.
    const legacy = hit({
      id: "ddgs:legacy",
      provider: "ddgs",
      url: "https://cdn.example.com/r.jpg",
      source: "www.reddit.com",
      license: "来源网页（许可证未验证；仅作搜索聚合）",
      foreignLandingUrl: "https://www.reddit.com/r/example/",
    });
    assert.equal(isUnverifiedLicenseDisclaimer(legacy.license), true);
    assert.equal(requiresVisibleAttribution(legacy), false);
    assert.equal(formatMinimalVisibleCredit(legacy), undefined);
    resetImageChatReplyCursorForTests();
    const legacyChat = formatChatImageFollowUp(legacy);
    assert.equal(legacyChat, "这张不错");
    assert.doesNotMatch(legacyChat, /图：/);
    assert.doesNotMatch(legacyChat, /许可证未验证|仅作搜索聚合|来源网页/);
    assert.equal(containsTechnicalAttributionText(legacyChat), false);

    const internal = formatInternalImageAttribution(legacy);
    assert.match(internal, /许可证未验证|仅作搜索聚合|来源网页/);

    const ddgs = mapDdgsResult(
      {
        title: "Minji",
        image: "https://cdn.example.com/m.jpg",
        url: "https://www.reddit.com/r/x/",
        source: "www.reddit.com",
      },
      0,
    )!;
    assert.equal(ddgs.license, undefined);
    resetImageChatReplyCursorForTests();
    const ddgsChat = formatChatImageFollowUp(ddgs);
    assert.match(ddgsChat, /这张不错|这张你看看|这个好棒|看看这张呢|发你一张|先看这张/);
    assert.doesNotMatch(ddgsChat, /图：|许可证未验证|仅作搜索聚合|来源网页|www\.reddit/);
    assert.match(formatInternalImageAttribution(ddgs), /仅作搜索聚合/);

    const sx = mapSearxngResult(
      {
        title: "Minji",
        img_src: "https://cdn.example.com/s.jpg",
        url: "https://example.com/s",
        engine: "google_images",
      },
      0,
    )!;
    assert.equal(sx.license, undefined);
    resetImageChatReplyCursorForTests();
    const sxChat = formatChatImageFollowUp(sx);
    assert.doesNotMatch(sxChat, /图：|许可证未验证|SearXNG|来源网页/);
    assert.match(formatInternalImageAttribution(sx), /SearXNG|许可证未验证/);
  });
});

describe("download retry classification", () => {
  it("treats HTTP 404 as retryable and SSRF as not", () => {
    assert.equal(
      isRetryableImageDownloadError(
        new ImageDownloadError("Image download HTTP 404", "http", 404),
      ),
      true,
    );
    assert.equal(
      isRetryableImageDownloadError(
        new ImageDownloadError("Private IP", "ssrf"),
      ),
      false,
    );
  });
});

describe("ImageMediaService relevance + download fallback (mocked)", () => {
  it("refuses to send when Openverse only returns IMG_4617 parade noise", async () => {
    clearImageSearchCache();
    clearRecentlySent();

    const paradeOnly: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.openverse.org")) {
        return Response.json({
          results: [
            {
              id: "parade",
              title: "IMG_4617",
              url: "https://example.com/parade.png",
              width: 1024,
              height: 683,
              creator: "chineseinus.org",
              source: "flickr",
              license: "by",
            },
          ],
        });
      }
      return new Response("nope", { status: 500 });
    };
    const svc = new ImageMediaService(
      {
        enabled: true,
        rateLimitPerMinute: 100,
        providerPriority: ["openverse"],
      },
      { fetchImpl: paradeOnly, resolveHost: async () => undefined },
    );
    const bad = await svc.findAndDownload("张元英", "c2c:test");
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.error, /没找到|不会随手/);
  });

  it("skips stale HTTP 404 and downloads the next relevant candidate", async () => {
    clearImageSearchCache();
    clearRecentlySent();

    const fetched: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.openverse.org")) {
        return Response.json({
          results: [
            {
              id: "stale-top",
              title: "251102 Jang Wonyoung @ IVE SHOW WHAT I AM Day3 (4)",
              url: "https://cdn.example.com/stale-wonyoung.jpg",
              width: 2730,
              height: 4096,
              creator: "티비텐",
              source: "wikimedia",
              license: "by",
              license_url: "https://creativecommons.org/licenses/by/4.0/",
              foreign_landing_url: "https://commons.wikimedia.org/wiki/File:stale",
            },
            {
              id: "noise",
              title: "IMG_4617",
              url: "https://cdn.example.com/parade.png",
              width: 1024,
              height: 683,
              creator: "chineseinus.org",
              source: "flickr",
              license: "by",
            },
            {
              id: "good",
              title: "장원영 (JANG WONYOUNG) - RIMOWA - 2023.05.13 P1",
              url: "https://cdn.example.com/good-wonyoung.png",
              width: 1837,
              height: 2296,
              creator: "티비텐",
              source: "wikimedia",
              license: "by",
              license_url: "https://creativecommons.org/licenses/by/4.0/",
              foreign_landing_url: "https://commons.wikimedia.org/wiki/File:good",
            },
          ],
        });
      }
      fetched.push(url);
      if (url.includes("stale-wonyoung")) {
        return new Response("gone", { status: 404 });
      }
      if (url.includes("good-wonyoung")) {
        return new Response(PNG_1X1, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("nope", { status: 500 });
    };

    const svc = new ImageMediaService(
      {
        enabled: true,
        rateLimitPerMinute: 100,
        maxDownloadAttempts: 5,
        providerPriority: ["openverse"],
      },
      { fetchImpl, resolveHost: async () => undefined },
    );
    const got = await svc.findAndDownload("张元英", "c2c:stale-404");
    assert.equal(got.ok, true);
    if (got.ok) {
      assert.equal(got.hit.id, "openverse:good");
      assert.match(got.chatReply, /这张|看看|好棒|发你/);
      assert.match(got.attribution, /Wikimedia Commons/);
      assert.match(got.attribution, /티비텐/);
    }
    assert.ok(fetched.some((u) => u.includes("stale-wonyoung")));
    assert.ok(fetched.some((u) => u.includes("good-wonyoung")));
    assert.equal(
      fetched.some((u) => u.includes("parade")),
      false,
      "must not fall back to unrelated parade image",
    );
  });

  it("returns honest failure when all relevant candidates 404", async () => {
    clearImageSearchCache();
    clearRecentlySent();

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.openverse.org")) {
        return Response.json({
          results: [
            {
              id: "a",
              title: "Jang Wonyoung IVE concert",
              url: "https://cdn.example.com/a.jpg",
              width: 800,
              height: 1000,
              source: "wikimedia",
              license: "by",
            },
            {
              id: "b",
              title: "장원영 Jang Wonyoung portrait",
              url: "https://cdn.example.com/b.jpg",
              width: 900,
              height: 1200,
              source: "wikimedia",
              license: "by",
            },
          ],
        });
      }
      return new Response("gone", { status: 404 });
    };

    const svc = new ImageMediaService(
      {
        enabled: true,
        rateLimitPerMinute: 100,
        maxDownloadAttempts: 3,
        providerPriority: ["openverse"],
      },
      { fetchImpl, resolveHost: async () => undefined },
    );
    const bad = await svc.findAndDownload("张元英", "c2c:all-404");
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.match(bad.error, /下载失败|链接失效/);
      assert.doesNotMatch(bad.error, /Image download HTTP 404/);
    }
  });

  it("lists multiple strong candidates in score order for 张元英", () => {
    const entity = matchImageEntity("张元英")!;
    const ranked = listRelevantImages(
      [
        hit({
          id: "low",
          url: "https://cdn.example.com/low.jpg",
          title: "Jang Wonyoung",
          width: 400,
          height: 500,
          source: "wikimedia",
        }),
        hit({
          id: "high",
          url: "https://cdn.example.com/high.jpg",
          title: "251102 Jang Wonyoung @ IVE SHOW WHAT I AM Day3 (4)",
          width: 2730,
          height: 4096,
          source: "wikimedia",
        }),
        hit({
          id: "noise",
          url: "https://cdn.example.com/noise.jpg",
          title: "IMG_4617",
          source: "flickr",
        }),
      ],
      {
        subject: "张元英",
        entity,
        requireStrongEvidence: true,
        minWidth: 200,
        minHeight: 200,
      },
    );
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0]?.hit.id, "high");
    assert.equal(ranked[1]?.hit.id, "low");
  });

  it("does not deepen search solely because unrelated images were sent earlier", async () => {
    clearImageSearchCache();
    clearRecentlySent();
    clearDeadImages();
    rememberSentImage("c2c:budget", "openverse:prior-other-subject");

    let openverseCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.openverse.org")) {
        openverseCalls += 1;
        return Response.json({
          results: [
            {
              id: "yuna",
              title: "251110 Shin Yuna from ITZY",
              url: "https://cdn.example.com/yuna.png",
              width: 1200,
              height: 1600,
              source: "wikimedia",
              license: "by 4.0",
              creator: "TV10",
            },
          ],
        });
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
        totalTimeoutMs: 20_000,
        maxDownloadAttempts: 3,
        providerPriority: ["openverse"],
      },
      { fetchImpl, resolveHost: async () => undefined },
    );
    const got = await svc.findAndDownload("申有娜", "c2c:budget");
    assert.equal(got.ok, true);
    // Prefer-source stop-early should keep Openverse calls small (no forced page-2).
    assert.ok(openverseCalls <= 4, `expected lean search, got ${openverseCalls}`);
  });

  it("skips previously sent + dead URLs on repeated 张元英 search", async () => {
    clearImageSearchCache();
    clearRecentlySent();
    clearDeadImages();

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.openverse.org")) {
        return Response.json({
          results: [
            {
              id: "dead1",
              title: "Jang Wonyoung IVE A",
              url: "https://cdn.example.com/dead1.jpg",
              width: 2000,
              height: 3000,
              source: "wikimedia",
              license: "by 4.0",
              creator: "A",
            },
            {
              id: "sent",
              title: "장원영 (JANG WONYOUNG) - RIMOWA",
              url: "https://cdn.example.com/sent.png",
              width: 1800,
              height: 2200,
              source: "wikimedia",
              license: "by 4.0",
              creator: "B",
            },
            {
              id: "alt",
              title: "Jang Wonyoung at Produce48 9",
              url: "https://cdn.example.com/alt.png",
              width: 900,
              height: 1200,
              source: "wikimedia",
              license: "by 4.0",
              creator: "C",
              foreign_landing_url: "https://commons.wikimedia.org/wiki/File:alt",
            },
          ],
        });
      }
      if (url.includes("dead1")) return new Response("gone", { status: 404 });
      if (url.includes("sent") || url.includes("alt")) {
        return new Response(PNG_1X1, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("nope", { status: 500 });
    };

    const svc = new ImageMediaService(
      {
        enabled: true,
        rateLimitPerMinute: 100,
        maxDownloadAttempts: 5,
        providerPriority: ["openverse"],
      },
      { fetchImpl, resolveHost: async () => undefined },
    );

    const first = await svc.findAndDownload("张元英", "c2c:repeat");
    assert.equal(first.ok, true);
    if (first.ok) {
      // dead1 skipped → sent wins
      assert.equal(first.hit.id, "openverse:sent");
      assert.match(first.chatReply, /这张|看看|好棒|发你|换/);
    }
    assert.equal(isDeadImage({ id: "openverse:dead1" }), true);

    // Second request: exclude sent, skip dead → alt
    const second = await svc.findAndDownload("张元英", "c2c:repeat", {
      preferDifferent: true,
    });
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.hit.id, "openverse:alt");

    // Mark alt dead too; only sent remains → honest “no other” after exclude
    rememberDeadImage({
      id: "openverse:alt",
      url: "https://cdn.example.com/alt.png",
    });
    rememberSentImage("c2c:repeat", "openverse:alt");
    const third = await svc.findAndDownload("张元英", "c2c:repeat", {
      preferDifferent: true,
    });
    assert.equal(third.ok, false);
    if (!third.ok) assert.match(third.error, /暂时没有其他/);
  });
});
