import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessImageRelevance,
  containsTechnicalAttributionText,
  formatChatImageFollowUp,
  formatInternalImageAttribution,
  formatMinimalVisibleCredit,
  listRelevantImages,
  matchImageEntity,
  normalizeImageSearchQuery,
  resetImageChatReplyCursorForTests,
  searchAcrossProviders,
  type ImageSearchProvider,
} from "../src/media/index.js";
import type { ImageSearchHit } from "../src/media/types.js";

function hit(
  partial: Partial<ImageSearchHit> & { id: string; url: string },
): ImageSearchHit {
  return {
    provider: "ddgs",
    width: 800,
    height: 1000,
    ...partial,
  };
}

function fakeProvider(
  id: string,
  hits: ImageSearchHit[],
  onSearch?: () => void,
): ImageSearchProvider {
  return {
    id,
    async search() {
      onSearch?.();
      return hits;
    },
  };
}

describe("idol alias + expansion coverage", () => {
  it("maps 金采源 / LE SSERAFIM Kim Chaewon to kim-chaewon", () => {
    for (const q of [
      "金采源",
      "金彩源",
      "Kim Chaewon",
      "LE SSERAFIM Kim Chaewon",
      "LE SSERAFIM Chaewon",
      "김채원",
    ]) {
      const n = normalizeImageSearchQuery(q);
      assert.equal(n.entity?.id, "kim-chaewon", q);
      assert.equal(n.requireStrongEvidence, true, q);
      assert.ok(
        n.searchQueries.some((s) => /Chaewon|김채원|金采源|LE SSERAFIM/i.test(s)),
        `${q} → ${n.searchQueries.join(" | ")}`,
      );
    }
  });

  it("maps 金玟池 / NewJeans Minji to newjeans-minji", () => {
    for (const q of ["金玟池", "NewJeans Minji", "minji", "민지"]) {
      const n = normalizeImageSearchQuery(q);
      assert.equal(n.entity?.id, "newjeans-minji", q);
      assert.ok(n.searchQueries.some((s) => /Minji|NewJeans|金玟池|민지/i.test(s)));
    }
  });

  it("maps 申有娜 / ITZY Yuna to shin-yuna", () => {
    for (const q of ["申有娜", "ITZY Yuna", "Shin Yuna", "신유나"]) {
      const n = normalizeImageSearchQuery(q);
      assert.equal(n.entity?.id, "shin-yuna", q);
      assert.ok(n.searchQueries.some((s) => /Yuna|ITZY|신유나|申有娜/i.test(s)));
    }
  });
});

describe("identity validation — aliases vs false matches", () => {
  it("accepts Chaewon EN titles and rejects unrelated idols", () => {
    const entity = matchImageEntity("金采源")!;
    const good = hit({
      id: "cw",
      url: "https://cdn.example.com/cw.jpg",
      title: "Kim Chaewon of LE SSERAFIM",
      source: "www.reddit.com",
    });
    const other = hit({
      id: "wy",
      url: "https://cdn.example.com/wy.jpg",
      title: "Jang Wonyoung IVE",
      source: "www.reddit.com",
    });
    const bareGroup = hit({
      id: "grp",
      url: "https://cdn.example.com/g.jpg",
      title: "LE SSERAFIM group photo",
      source: "www.reddit.com",
    });
    assert.equal(
      assessImageRelevance(good, {
        subject: "金采源",
        entity,
        requireStrongEvidence: true,
      }).strong,
      true,
    );
    assert.equal(
      listRelevantImages([other, bareGroup], {
        subject: "金采源",
        entity,
        requireStrongEvidence: true,
        minWidth: 0,
        minHeight: 0,
      }).length,
      0,
    );
    assert.equal(
      listRelevantImages([other, bareGroup, good], {
        subject: "金采源",
        entity,
        requireStrongEvidence: true,
        minWidth: 0,
        minHeight: 0,
      })[0]?.hit.id,
      "cw",
    );
  });

  it("does not treat bare NewJeans titles as Minji", () => {
    const entity = matchImageEntity("金玟池")!;
    const groupOnly = hit({
      id: "nj",
      url: "https://cdn.example.com/nj.jpg",
      title: "NewJeans OT5",
      source: "www.reddit.com",
    });
    const minji = hit({
      id: "mj",
      url: "https://i.redd.it/minji.jpg",
      title: "NewJeans Minji airport",
      source: "www.reddit.com",
    });
    assert.equal(
      assessImageRelevance(groupOnly, {
        subject: "金玟池",
        entity,
        requireStrongEvidence: true,
      }).strong,
      false,
    );
    assert.equal(
      pickId([groupOnly, minji], "金玟池", entity),
      "mj",
    );
  });

  it("requires group context for bare given-name Yuna titles", () => {
    const entity = matchImageEntity("申有娜")!;
    const bare = hit({
      id: "bare",
      url: "https://cdn.example.com/y.jpg",
      title: "Yuna concert",
      source: "flickr",
    });
    const itzy = hit({
      id: "itzy",
      url: "https://cdn.example.com/y2.jpg",
      title: "Yuna ITZY showcase",
      source: "flickr",
    });
    assert.equal(
      assessImageRelevance(bare, {
        subject: "申有娜",
        entity,
        requireStrongEvidence: true,
      }).strong,
      false,
    );
    assert.equal(
      assessImageRelevance(itzy, {
        subject: "申有娜",
        entity,
        requireStrongEvidence: true,
      }).strong,
      true,
    );
  });
});

function pickId(
  hits: ImageSearchHit[],
  subject: string,
  entity: NonNullable<ReturnType<typeof matchImageEntity>>,
): string | undefined {
  return listRelevantImages(hits, {
    subject,
    entity,
    requireStrongEvidence: true,
    minWidth: 0,
    minHeight: 0,
  })[0]?.hit.id;
}

describe("validation-aware provider fallback", () => {
  it("continues past DDGS when all candidates fail identity validation", async () => {
    let dtCalls = 0;
    const ddgs = fakeProvider("ddgs", [
      hit({
        id: "ddgs:junk1",
        url: "https://a.example/1.jpg",
        title: "random parade IMG_4617",
      }),
      hit({
        id: "ddgs:junk2",
        url: "https://a.example/2.jpg",
        title: "stock photo landscape",
      }),
    ]);
    const sx = fakeProvider("searxng", []); // unconfigured-like empty
    const dt = fakeProvider(
      "duitang",
      [
        hit({
          id: "dt:cw",
          provider: "duitang",
          url: "https://c.example/cw.jpg",
          title: "金采源 LE SSERAFIM 金采源",
        }),
      ],
      () => {
        dtCalls += 1;
      },
    );
    const entity = matchImageEntity("金采源")!;
    const hits = await searchAcrossProviders([ddgs, sx, dt], {
      queries: ["Kim Chaewon LE SSERAFIM"],
      stopAfterHits: 2,
      originalQuery: "金采源",
      countTowardQuota: (h) =>
        assessImageRelevance(h, {
          subject: "金采源",
          entity,
          requireStrongEvidence: true,
        }).strong,
    });
    assert.equal(dtCalls, 1, "Duitang must run after DDGS junk");
    assert.ok(hits.some((h) => h.id === "dt:cw"));
    assert.ok(
      listRelevantImages(hits, {
        subject: "金采源",
        entity,
        requireStrongEvidence: true,
        minWidth: 0,
        minHeight: 0,
      }).some((p) => p.hit.id === "dt:cw"),
    );
  });

  it("continues when DDGS returns broken/irrelevant URLs and later provider succeeds", async () => {
    const entity = matchImageEntity("金玟池")!;
    let ovCalls = 0;
    const ddgs = fakeProvider("ddgs", [
      hit({
        id: "ddgs:bad",
        url: "https://broken.example/x.jpg",
        title: "cute cat",
      }),
    ]);
    const ov = fakeProvider(
      "openverse",
      [
        hit({
          id: "ov:mj",
          provider: "openverse",
          url: "https://upload.wikimedia.org/minji.jpg",
          title: "NewJeans Minji",
          source: "wikimedia",
          license: "by 4.0",
          creator: "Photog",
        }),
      ],
      () => {
        ovCalls += 1;
      },
    );
    const hits = await searchAcrossProviders([ddgs, ov], {
      queries: ["NewJeans Minji"],
      stopAfterHits: 1,
      countTowardQuota: (h) =>
        assessImageRelevance(h, {
          subject: "金玟池",
          entity,
          requireStrongEvidence: true,
        }).strong,
    });
    assert.equal(ovCalls, 1);
    assert.equal(hits.find((h) => h.id === "ov:mj")?.provider, "openverse");
  });

  it("does not claim success when every provider fails validation", async () => {
    const entity = matchImageEntity("金采源")!;
    const hits = await searchAcrossProviders(
      [
        fakeProvider("ddgs", [
          hit({ id: "a", url: "https://a.example/a.jpg", title: "cat" }),
        ]),
        fakeProvider("duitang", [
          hit({ id: "b", url: "https://b.example/b.jpg", title: "dog" }),
        ]),
      ],
      {
        queries: ["Kim Chaewon"],
        stopAfterHits: 3,
        countTowardQuota: (h) =>
          assessImageRelevance(h, {
            subject: "金采源",
            entity,
            requireStrongEvidence: true,
          }).strong,
      },
    );
    assert.equal(
      listRelevantImages(hits, {
        subject: "金采源",
        entity,
        requireStrongEvidence: true,
        minWidth: 0,
        minHeight: 0,
      }).length,
      0,
    );
  });

  it("skips empty SearXNG without blocking Duitang", async () => {
    let dt = 0;
    const hits = await searchAcrossProviders(
      [
        fakeProvider("ddgs", []),
        fakeProvider("searxng", []),
        fakeProvider(
          "duitang",
          [
            hit({
              id: "dt:1",
              provider: "duitang",
              url: "https://c.example/1.jpg",
              title: "金玟池 NewJeans Minji",
            }),
          ],
          () => {
            dt += 1;
          },
        ),
      ],
      { queries: ["NewJeans Minji"], stopAfterHits: 1 },
    );
    assert.equal(dt, 1);
    assert.equal(hits[0]?.provider, "duitang");
  });
});

describe("QQ caption policy for aggregator hits", () => {
  it("DDGS Minji follow-up stays casual without technical attribution", () => {
    const h = hit({
      id: "ddgs:mj",
      provider: "ddgs",
      url: "https://i.redd.it/m.jpg",
      title: "NewJeans Minji",
      source: "www.reddit.com",
      foreignLandingUrl: "https://www.reddit.com/r/x/",
    });
    resetImageChatReplyCursorForTests();
    const chat = formatChatImageFollowUp(h);
    assert.match(chat, /这张不错|这张你看看|这个好棒|看看这张呢|发你一张|先看这张/);
    assert.doesNotMatch(chat, /图：|许可证未验证|仅作搜索聚合|来源网页|www\.reddit/);
    assert.equal(formatMinimalVisibleCredit(h), undefined);
    assert.equal(containsTechnicalAttributionText(chat), false);
    assert.match(formatInternalImageAttribution(h), /仅作搜索聚合|许可证未验证/);
  });
});
