import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildImageProviderRegistry,
  clearImageSearchCache,
  clearRecentlySent,
  createImageProviders,
  DEFAULT_PROVIDER_PRIORITY,
  enabledProviderIds,
  ImageMediaService,
  parseImageSlashArgs,
  type ImageSearchProvider,
} from "../src/media/index.js";
import type { ImageSearchHit } from "../src/media/types.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function hit(
  partial: Partial<ImageSearchHit> & {
    id: string;
    url: string;
    provider: ImageSearchHit["provider"];
  },
): ImageSearchHit {
  return {
    width: 800,
    height: 1000,
    title: partial.title ?? "NewJeans Minji",
    ...partial,
  };
}

function trackingProviders(called: string[]) {
  const ddgs: ImageSearchProvider = {
    id: "ddgs",
    async search() {
      called.push("ddgs");
      return [
        hit({
          id: "ddgs:1",
          provider: "ddgs",
          url: "https://cdn.example.com/m.jpg",
          title: "NewJeans Minji airport",
        }),
      ];
    },
  };
  const duitang: ImageSearchProvider = {
    id: "duitang",
    async search() {
      called.push("duitang");
      return [
        hit({
          id: "dt:1",
          provider: "duitang",
          url: "https://c.example/d.jpg",
          title: "金玟池 NewJeans",
        }),
      ];
    },
  };
  const openverse: ImageSearchProvider = {
    id: "openverse",
    async search() {
      called.push("openverse");
      return [
        hit({
          id: "ov:1",
          provider: "openverse",
          url: "https://upload.wikimedia.org/m.jpg",
          title: "NewJeans Minji",
          source: "wikimedia",
          license: "by 4.0",
        }),
      ];
    },
  };
  const searxng: ImageSearchProvider = {
    id: "searxng",
    async search() {
      called.push("searxng");
      return [];
    },
  };
  return { ddgs, duitang, openverse, searxng };
}

describe("DDGS-only default provider policy", () => {
  beforeEach(() => {
    clearImageSearchCache();
    clearRecentlySent();
  });

  it("defaults ordinary search to DDGS exclusively", () => {
    assert.deepEqual(DEFAULT_PROVIDER_PRIORITY, ["ddgs"]);
    assert.deepEqual(enabledProviderIds({}), ["ddgs"]);
    const ordered = createImageProviders({
      ddgsEnabled: true,
      duitangEnabled: true,
      searxngBaseUrl: "https://sx.example",
    });
    assert.deepEqual(
      ordered.map((p) => p.id),
      ["ddgs"],
    );
    const reg = buildImageProviderRegistry({
      ddgsEnabled: true,
      duitangEnabled: true,
      searxngBaseUrl: "https://sx.example",
    });
    assert.ok(reg.has("ddgs"));
    assert.ok(reg.has("duitang"));
    assert.ok(reg.has("searxng"));
    assert.ok(reg.has("openverse"));
  });

  it("ordinary NL search never invokes Duitang, SearXNG, or Openverse", async () => {
    const called: string[] = [];
    const { ddgs, duitang, openverse, searxng } = trackingProviders(called);
    const svc = new ImageMediaService(
      {
        enabled: true,
        providerPriority: ["ddgs"],
        autoFallback: false,
        rateLimitPerMinute: 100,
        duitang: { enabled: true, deliveryMode: "image" },
      },
      {
        providers: [ddgs, searxng, duitang, openverse],
        resolveHost: async () => undefined,
        fetchImpl: async () =>
          new Response(PNG_1X1, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
      },
    );

    const out = await svc.findAndDownload("金玟池", "c2c:ddgs-only");
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.hit.provider, "ddgs");
    assert.deepEqual(called, ["ddgs"]);
  });

  it("fails honestly when DDGS has no usable hit — does not substitute Duitang", async () => {
    const called: string[] = [];
    const ddgs: ImageSearchProvider = {
      id: "ddgs",
      async search() {
        called.push("ddgs");
        return [
          hit({
            id: "ddgs:junk",
            provider: "ddgs",
            url: "https://cdn.example.com/junk.jpg",
            title: "random cat parade",
          }),
        ];
      },
    };
    const duitang: ImageSearchProvider = {
      id: "duitang",
      async search() {
        called.push("duitang");
        return [
          hit({
            id: "dt:good",
            provider: "duitang",
            url: "https://c.example/good.jpg",
            title: "金玟池 NewJeans Minji",
          }),
        ];
      },
    };
    const svc = new ImageMediaService(
      {
        enabled: true,
        providerPriority: ["ddgs"],
        autoFallback: false,
        rateLimitPerMinute: 100,
        duitang: { enabled: true, deliveryMode: "image" },
      },
      {
        providers: [ddgs, duitang],
        resolveHost: async () => undefined,
      },
    );
    const out = await svc.findAndDownload("金玟池", "c2c:no-fallback");
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.match(
        out.error,
        /没找到|不发了|不换成别的图源|其他图源|能确认|ddgs/i,
      );
      assert.doesNotMatch(out.error, /堆糖/);
    }
    assert.deepEqual(called, ["ddgs"]);
  });

  it("/image --provider=ddgs uses only DDGS with no fallback", async () => {
    assert.deepEqual(parseImageSlashArgs(["--provider=ddgs", "Minji"]), {
      query: "Minji",
      provider: "ddgs",
    });
    const called: string[] = [];
    const ddgs: ImageSearchProvider = {
      id: "ddgs",
      async search() {
        called.push("ddgs");
        return [];
      },
    };
    const openverse: ImageSearchProvider = {
      id: "openverse",
      async search() {
        called.push("openverse");
        return [
          hit({
            id: "ov:1",
            provider: "openverse",
            url: "https://upload.wikimedia.org/m.jpg",
            title: "NewJeans Minji",
            source: "wikimedia",
            license: "by 4.0",
          }),
        ];
      },
    };
    const svc = new ImageMediaService(
      {
        enabled: true,
        providerPriority: ["ddgs"],
        autoFallback: false,
        rateLimitPerMinute: 100,
      },
      {
        providers: [ddgs, openverse],
        resolveHost: async () => undefined,
      },
    );
    const out = await svc.findAndDownload("金玟池", "c2c:pin", {
      provider: "ddgs",
    });
    assert.equal(out.ok, false);
    assert.deepEqual(called, ["ddgs"]);
    assert.ok(!called.includes("openverse"));
  });
});
