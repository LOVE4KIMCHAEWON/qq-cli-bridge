import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CultureStore } from "../src/culture/store.js";
import { retrieveCultureHits } from "../src/culture/retrieve.js";
import { DEFAULT_CULTURE_CONFIG } from "../src/culture/types.js";

type BenchCase = {
  id: string;
  utterance: string;
  expectTerms: string[];
  expectPatterns: string[];
};

type BenchFile = {
  version: number;
  cases: BenchCase[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "culture-benchmark.json");

describe("Culture slang benchmark (Phase 0)", () => {
  let store: CultureStore;
  let cases: BenchCase[];

  before(() => {
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as BenchFile;
    cases = raw.cases;
    store = new CultureStore({ dbPath: ":memory:" });
  });

  it("scores retrieval against curated fixture", () => {
    let pass = 0;
    const failures: string[] = [];

    for (const c of cases) {
      const hits = retrieveCultureHits(
        store,
        "bench:c2c",
        c.utterance,
        DEFAULT_CULTURE_CONFIG,
      );
      const termLabels = new Set(
        hits.filter((h) => h.kind === "term").map((h) => h.label),
      );
      const patLabels = new Set(
        hits.filter((h) => h.kind === "pattern").map((h) => h.label),
      );

      const termsOk = c.expectTerms.every((t) => termLabels.has(t));
      const patsOk = c.expectPatterns.every((p) => patLabels.has(p));
      const noExtraOnNegative =
        c.expectTerms.length === 0 && c.expectPatterns.length === 0
          ? hits.length === 0
          : true;

      if (termsOk && patsOk && noExtraOnNegative) {
        pass++;
      } else {
        failures.push(
          `${c.id}: got terms=[${[...termLabels]}] patterns=[${[...patLabels]}]`,
        );
      }
    }

    const rate = pass / cases.length;
    assert.equal(
      failures.length,
      0,
      `benchmark failures (${pass}/${cases.length} = ${(rate * 100).toFixed(0)}%):\n${failures.join("\n")}`,
    );
    assert.ok(rate >= 0.9, `pass rate ${rate} below 90%`);
  });
});
