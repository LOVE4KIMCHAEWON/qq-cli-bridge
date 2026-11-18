import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessImageRelevance,
  clearImageSearchCache,
  clearRecentlySent,
  getCachedHits,
  ImageMediaService,
  mapDdgsResult,
  normalizeImageSearchQuery,
  parseDdgsScriptOutput,
  setCachedHits,
  DdgsImageProvider,
} from "../src/media/index.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "../scripts/ddgs_images.py");

describe("DDGS Windows encoding + empty-cache root cause", () => {
  beforeEach(() => {
    clearImageSearchCache();
    clearRecentlySent();
  });

  it("helper script emits ASCII-only JSON (safe on cp936/gbk stdout)", () => {
    const src = fs.readFileSync(scriptPath, "utf8");
    assert.match(src, /ensure_ascii\s*=\s*True/);
    assert.doesNotMatch(
      src,
      /print\(json\.dumps\([^\)]*ensure_ascii\s*=\s*False/,
    );
  });

  it("parseDdgsScriptOutput tolerates BOM, warnings, and \\uXXXX Hangul titles", () => {
    const payload = {
      ok: true,
      results: [
        {
          title: "LE SSERAFIM \uAE40\uCC44\uC6D0 Kim Chaewon",
          image: "https://cdn.example.com/cw.jpg",
          thumbnail: "https://cdn.example.com/cw-t.jpg",
          url: "https://example.com/cw",
          width: 800,
          height: 1000,
          source: "example.com",
        },
        {
          title: "Iroha | ILLIT Wiki",
          image: "https://cdn.example.com/iroha.jpg",
          url: "https://illit.fandom.com/wiki/Iroha",
          source: "illit.fandom.com",
        },
      ],
    };
    const asciiJson = JSON.stringify(payload);
    const withBom = `\uFEFF${asciiJson}`;
    const withWarn = `RuntimeWarning: something\n${asciiJson}\n`;
    for (const text of [asciiJson, withBom, withWarn]) {
      const parsed = parseDdgsScriptOutput(text, "");
      assert.equal(parsed.ok, true, text.slice(0, 40));
      assert.equal(parsed.results?.length, 2);
      const cw = mapDdgsResult(parsed.results![0]!, 0)!;
      assert.match(cw.title ?? "", /Kim Chaewon|채원|金采源/i);
    }
  });

  it("does not poison search cache with empty DDGS misses", () => {
    setCachedHits("ddgs:kim-chaewon:test", []);
    assert.equal(getCachedHits("ddgs:kim-chaewon:test"), undefined);
    setCachedHits("ddgs:kim-chaewon:test", [
      {
        id: "ddgs:1",
        provider: "ddgs",
        url: "https://cdn.example.com/a.jpg",
        title: "Kim Chaewon",
      },
    ]);
    assert.equal(getCachedHits("ddgs:kim-chaewon:test")?.length, 1);
  });

  it("DdgsImageProvider retries once after empty/error then maps candidates", async () => {
    let calls = 0;
    const provider = new DdgsImageProvider({
      runScript: async () => {
        calls += 1;
        if (calls === 1) {
          return { ok: false, error: "UnicodeEncodeError: gbk" };
        }
        return {
          ok: true,
          results: [
            {
              title: "Kim Chaewon LE SSERAFIM",
              image: "https://cdn.example.com/cw.jpg",
              url: "https://example.com/cw",
              source: "reddit.com",
            },
          ],
        };
      },
    });
    const hits = await provider.search({
      queries: ["Kim Chaewon LE SSERAFIM"],
      pageSize: 8,
      maxQueries: 1,
    });
    assert.equal(calls, 2);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.provider, "ddgs");
  });
});

describe("Chaewon + Iroha regressions (shared DDGS drop point)", () => {
  beforeEach(() => {
    clearImageSearchCache();
    clearRecentlySent();
  });

  it("金采源 / LE SSERAFIM Kim Chaewon: Hangul titles map + pass strong identity", async () => {
    const normalized = normalizeImageSearchQuery("金采源");
    assert.equal(normalized.entity?.id, "kim-chaewon");
    assert.ok(
      normalized.searchQueries.some((q) => /Chaewon|LE SSERAFIM/i.test(q)),
    );

    // Titles matching the user's working Python DDGS sample (incl. Hangul/JP).
    const rawResults = [
      {
        title: "LE SSERAFIM \uAE40\uCC44\uC6D0 #KimChaewon",
        image: "https://cdn.example.com/chaewon-hangul.jpg",
        url: "https://www.facebook.com/LESSERAFIM_Chaewon",
        source: "facebook.com",
      },
      {
        title: "LE SSERAFIM \u30AD\u30E0\u30FB\u30C1\u30A7\u30A6\u30A9\u30F3",
        image: "https://cdn.example.com/chaewon-jp.jpg",
        url: "https://www.nikkansports.com/chaewon",
        source: "nikkansports.com",
      },
      {
        title: "Kim Chaewon of LE SSERAFIM concept photo",
        image: "https://cdn.example.com/chaewon-en.jpg",
        url: "https://dbkpop.com/chaewon",
        source: "dbkpop.com",
      },
    ];
    const mapped = rawResults
      .map((r, i) => mapDdgsResult(r, i))
      .filter((h): h is NonNullable<typeof h> => !!h);
    assert.equal(mapped.length, 3, "before: encoding crash → 0 mapped");

    const strong = mapped.filter(
      (h) =>
        assessImageRelevance(h, {
          subject: normalized.subject,
          entity: normalized.entity,
          requireStrongEvidence: true,
        }).strong,
    );
    assert.ok(
      strong.length >= 1,
      `expected ≥1 strong Chaewon hit, got ${strong.length}`,
    );

    let searchCalls = 0;
    const svc = new ImageMediaService(
      {
        enabled: true,
        rateLimitPerMinute: 100,
        providerPriority: ["ddgs"],
        ddgs: { enabled: true },
        autoFallback: false,
      },
      {
        providers: [
          {
            id: "ddgs",
            async search() {
              searchCalls += 1;
              return mapped;
            },
          },
        ],
        fetchImpl: async () =>
          new Response(PNG_1X1, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        resolveHost: async () => undefined,
      },
    );

    const out = await svc.findAndDownload("金采源", "c2c:chaewon-enc");
    assert.equal(searchCalls, 1);
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.hit.provider, "ddgs");
      assert.equal(out.delivery, "image");
      if (out.delivery === "image") {
        assert.ok(out.downloaded.byteLength > 0);
      }
    }
  });

  it("ILLIT Iroha: fandom titles map + topical pass under DDGS-only", async () => {
    const normalized = normalizeImageSearchQuery("ILLIT Iroha");
    assert.equal(normalized.entity, undefined);
    assert.deepEqual(normalized.searchQueries.slice(0, 1), ["ILLIT Iroha"]);

    const rawResults = [
      {
        title: "Iroha | ILLIT Wiki | Fandom",
        image: "https://cdn.example.com/iroha-wiki.jpg",
        url: "https://illit.fandom.com/wiki/Iroha",
        source: "illit.fandom.com",
      },
      {
        title: "Iroha (ILLIT) profile",
        image: "https://cdn.example.com/iroha-profile.jpg",
        url: "https://thecityceleb.com/iroha",
        source: "thecityceleb.com",
      },
      {
        title: "ILLIT Iroha concept photos",
        image: "https://cdn.example.com/iroha-concept.jpg",
        url: "https://kr.pinterest.com/iroha",
        source: "pinterest.com",
      },
    ];
    const mapped = rawResults
      .map((r, i) => mapDdgsResult(r, i))
      .filter((h): h is NonNullable<typeof h> => !!h);
    assert.equal(mapped.length, 3, "before: encoding crash → 0 mapped");

    const topical = mapped.filter(
      (h) =>
        assessImageRelevance(h, {
          subject: normalized.subject,
          requireStrongEvidence: false,
        }).topical ||
        assessImageRelevance(h, {
          subject: normalized.subject,
          requireStrongEvidence: false,
        }).strong,
    );
    assert.ok(
      topical.length >= 2,
      `expected ≥2 topical Iroha hits, got ${topical.length}`,
    );

    const svc = new ImageMediaService(
      {
        enabled: true,
        rateLimitPerMinute: 100,
        providerPriority: ["ddgs"],
        ddgs: { enabled: true },
        autoFallback: false,
      },
      {
        providers: [
          {
            id: "ddgs",
            async search() {
              return mapped;
            },
          },
        ],
        fetchImpl: async () =>
          new Response(PNG_1X1, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        resolveHost: async () => undefined,
      },
    );

    const out = await svc.findAndDownload("ILLIT Iroha", "c2c:iroha-enc");
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.hit.provider, "ddgs");
      assert.equal(out.delivery, "image");
      if (out.delivery === "image") {
        assert.ok(out.downloaded.byteLength > 0);
      }
    }
  });
});
