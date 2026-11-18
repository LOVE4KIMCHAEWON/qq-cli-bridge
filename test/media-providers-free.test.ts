import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createImageProviders,
  DEFAULT_PROVIDER_PRIORITY,
  enabledProviderIds,
  expandWebImageQueries,
  mapDdgsResult,
  mapSearxngResult,
  normalizeSearxngBaseUrl,
  parseImageCount,
  parseImageIntent,
  parseImageSlashArgs,
  searchAcrossProviders,
  type ImageSearchProvider,
} from "../src/media/index.js";
import type { ImageSearchHit } from "../src/media/types.js";

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

describe("free provider adapters", () => {
  it("maps DDGS raw results to ImageSearchHit", () => {
    const hit = mapDdgsResult(
      {
        title: "NewJeans Minji",
        image: "https://cdn.example.com/a.jpg",
        thumbnail: "https://cdn.example.com/t.jpg",
        url: "https://example.com/page",
        width: "800",
        height: "1200",
      },
      0,
    );
    assert.ok(hit);
    assert.equal(hit!.provider, "ddgs");
    assert.equal(hit!.url, "https://cdn.example.com/a.jpg");
    assert.equal(hit!.thumbnailUrl, "https://cdn.example.com/t.jpg");
    assert.equal(hit!.width, 800);
    assert.equal(hit!.foreignLandingUrl, "https://example.com/page");
    assert.equal(hit!.license, undefined);
    assert.doesNotMatch(hit!.attribution ?? "", /图：/);
    assert.match(hit!.attribution ?? "", /仅作搜索聚合|许可证未验证/);
    assert.equal(
      mapDdgsResult({ image: "http://insecure.example/x.jpg" }, 0),
      undefined,
    );
  });

  it("maps SearXNG JSON image rows", () => {
    const hit = mapSearxngResult(
      {
        title: "Minji airport",
        img_src: "https://img.example.com/m.jpg",
        thumbnail_src: "https://img.example.com/t.jpg",
        url: "https://news.example.com/m",
        resolution: "1920 x 1080",
        engine: "google_images",
      },
      1,
    );
    assert.ok(hit);
    assert.equal(hit!.provider, "searxng");
    assert.equal(hit!.width, 1920);
    assert.equal(hit!.height, 1080);
    assert.equal(hit!.license, undefined);
    assert.match(hit!.attribution ?? "", /SearXNG|许可证未验证/);
    assert.equal(normalizeSearxngBaseUrl("https://sx.example/"), "https://sx.example");
    assert.equal(normalizeSearxngBaseUrl(""), undefined);
  });
});

describe("sequential provider fallback", () => {
  it("does not call later providers when earlier fills quota", async () => {
    let bCalls = 0;
    const a = fakeProvider("ddgs", [
      {
        id: "ddgs:1",
        provider: "ddgs",
        url: "https://a.example/1.jpg",
        title: "Minji",
      },
      {
        id: "ddgs:2",
        provider: "ddgs",
        url: "https://a.example/2.jpg",
        title: "Minji 2",
      },
    ]);
    const b = fakeProvider(
      "searxng",
      [
        {
          id: "sx:1",
          provider: "searxng",
          url: "https://b.example/1.jpg",
          title: "x",
        },
      ],
      () => {
        bCalls += 1;
      },
    );
    const hits = await searchAcrossProviders([a, b], {
      queries: ["Minji"],
      stopAfterHits: 2,
    });
    assert.equal(hits.length, 2);
    assert.equal(bCalls, 0);
    assert.equal(hits.every((h) => h.provider === "ddgs"), true);
  });

  it("fills remaining quota from the next provider", async () => {
    const a = fakeProvider("ddgs", [
      {
        id: "ddgs:1",
        provider: "ddgs",
        url: "https://a.example/1.jpg",
        title: "one",
      },
    ]);
    const b = fakeProvider("searxng", [
      {
        id: "sx:1",
        provider: "searxng",
        url: "https://b.example/1.jpg",
        title: "two",
      },
      {
        id: "sx:dup",
        provider: "searxng",
        url: "https://a.example/1.jpg",
        title: "dup",
      },
    ]);
    const c = fakeProvider("duitang", [
      {
        id: "dt:1",
        provider: "duitang",
        url: "https://c.example/1.jpg",
        title: "three",
      },
    ]);
    const hits = await searchAcrossProviders([a, b, c], {
      queries: ["NewJeans"],
      stopAfterHits: 3,
    });
    assert.equal(hits.length, 3);
    assert.deepEqual(
      hits.map((h) => h.provider),
      ["ddgs", "searxng", "duitang"],
    );
  });

  it("skips empty / failing providers and continues", async () => {
    const fail: ImageSearchProvider = {
      id: "ddgs",
      async search() {
        throw new Error("network");
      },
    };
    const empty = fakeProvider("searxng", []);
    const ok = fakeProvider("duitang", [
      {
        id: "dt:1",
        provider: "duitang",
        url: "https://c.example/1.jpg",
        title: "ok",
      },
    ]);
    const hits = await searchAcrossProviders([fail, empty, ok], {
      queries: ["cat"],
      stopAfterHits: 1,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.provider, "duitang");
  });

  it("omits SearXNG when baseUrl missing", () => {
    const providers = createImageProviders({
      ddgsEnabled: false,
      duitangEnabled: true,
      searxngBaseUrl: "",
      priority: ["ddgs", "searxng", "duitang", "openverse"],
    });
    assert.equal(
      providers.some((p) => p.id === "searxng"),
      false,
    );
    assert.ok(providers.some((p) => p.id === "duitang"));
    assert.deepEqual(DEFAULT_PROVIDER_PRIORITY, ["ddgs"]);
    assert.deepEqual(
      enabledProviderIds({
        duitang: { enabled: true },
        searxng: { baseUrl: "" },
        providerPriority: ["ddgs", "searxng", "duitang"],
      }),
      ["ddgs", "duitang"],
    );
    assert.deepEqual(
      enabledProviderIds({
        providerPriority: ["ddgs"],
        autoFallback: false,
      }),
      ["ddgs"],
    );
    assert.deepEqual(
      enabledProviderIds({
        providerPriority: ["ddgs"],
        autoFallback: true,
      }),
      ["ddgs", "openverse"],
    );
  });
});

describe("query expansion + NL multi-image", () => {
  it("expands Minji / NewJeans aliases for web search", () => {
    const q = expandWebImageQueries("金玟池机场照");
    assert.ok(q.some((s) => /Minji|NewJeans|金玟池/i.test(s)));
    assert.ok(q.some((s) => /airport/i.test(s)));
    const g = expandWebImageQueries("NewJeans五人合照");
    assert.ok(g.some((s) => /group photo|five members|NewJeans/i.test(s)));
  });

  it("parses 再来三张 with last context", () => {
    assert.equal(parseImageCount("再来三张"), 3);
    assert.equal(parseImageCount("再来几张"), 2);
    const intent = parseImageIntent("再来三张", {
      lastImageQuery: "newjeans",
    });
    assert.equal(intent.kind, "search");
    if (intent.kind === "search") {
      assert.equal(intent.query, "newjeans");
      assert.equal(intent.preferDifferent, true);
      assert.equal(intent.count, 3);
    }
  });

  it("parses explicit provider on /image args", () => {
    assert.deepEqual(parseImageSlashArgs(["--provider=ddgs", "Minji", "airport"]), {
      query: "Minji airport",
      provider: "ddgs",
    });
    assert.deepEqual(parseImageSlashArgs(["@searxng", "cat"]), {
      query: "cat",
      provider: "searxng",
    });
  });

  it("keeps factual questions off the image path", () => {
    assert.equal(parseImageIntent("NewJeans出道哪年").kind, "none");
  });
});
