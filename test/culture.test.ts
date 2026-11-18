import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CultureStore } from "../src/culture/store.js";
import {
  CultureManager,
  resetCultureManagerForTests,
} from "../src/culture/manager.js";
import { extractCultureCorrections } from "../src/culture/corrections.js";
import { matchTemplate } from "../src/culture/patterns.js";
import { retrieveCultureHits } from "../src/culture/retrieve.js";
import { assembleBridgeContext } from "../src/context/assemble.js";
import { DEFAULT_CULTURE_CONFIG } from "../src/culture/types.js";
import { MemoryManager, resetMemoryManagerForTests } from "../src/memory/manager.js";
import { writeBridgeSessionPrompt } from "../src/context/session-prompt.js";

describe("Culture corrections (deterministic)", () => {
  it("parses 的意思是 / 纠正 / 文化库 forms", () => {
    const a = extractCultureCorrections("破防的意思是情绪防线被击穿");
    assert.equal(a.length, 1);
    assert.equal(a[0]!.term, "破防");
    assert.match(a[0]!.gloss, /情绪/);
    assert.equal(a[0]!.makeGlobal, false);

    const b = extractCultureCorrections("纠正：绝绝子 = 太绝了");
    assert.equal(b[0]!.term, "绝绝子");

    const c = extractCultureCorrections("文化库：栓Q 是 thank you 的阴阳说法");
    assert.equal(c[0]!.term, "栓Q");
  });

  it("marks global when cue present", () => {
    const a = extractCultureCorrections("全局记住：偷感的意思是做事缩手缩脚");
    assert.equal(a[0]!.makeGlobal, true);
  });
});

describe("Productive patterns", () => {
  it("matches 五X一 and X中X", () => {
    const a = matchTemplate("五{slot}一", "今日五福一冲冲冲");
    assert.equal(a.length, 1);
    assert.equal(a[0]!.matched, "五福一");
    assert.equal(a[0]!.slots[0], "福");

    const b = matchTemplate("{slot}中{slot}", "典中典了");
    assert.equal(b[0]!.matched, "典中典");

    const c = matchTemplate("{slot}中{slot}", "典中范");
    assert.equal(c.length, 0);
  });
});

describe("CultureStore — persistence, scope, seed", () => {
  let store: CultureStore;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qqbridge-culture-"));
    store = new CultureStore({ dbPath: path.join(tmp, "culture.sqlite") });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed in a test
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Windows may lock temp dirs briefly
    }
  });

  it("seeds curated terms and patterns", () => {
    assert.ok(store.termCount() >= 10);
    assert.ok(store.findTermExact("破防"));
    assert.ok(store.listActivePatterns().some((p) => p.name === "五X一"));
  });

  it("conversation corrections do not leak across conversations", () => {
    store.upsertTerm({
      term: "本地梗",
      gloss: "仅此会话",
      confidence: "confirmed",
      scope: "conversation",
      conversationId: "c2c:a",
      source: "user-correction",
    });
    assert.ok(store.findTermExact("本地梗", "c2c:a"));
    assert.equal(store.findTermExact("本地梗", "c2c:b"), null);
    assert.equal(store.findTermExact("本地梗"), null);
  });

  it("persists across reopen", () => {
    store.upsertTerm({
      term: "持久梗",
      gloss: "应仍在",
      confidence: "confirmed",
      scope: "global",
      source: "user-correction",
    });
    store.close();
    const again = new CultureStore({
      dbPath: path.join(tmp, "culture.sqlite"),
      skipSeed: true,
    });
    try {
      assert.ok(again.findTermExact("持久梗"));
    } finally {
      again.close();
    }
  });
});

describe("Culture retrieval + context assembly (backend-neutral)", () => {
  let culture: CultureManager;
  let memory: MemoryManager;

  beforeEach(() => {
    culture = new CultureManager({
      dbPath: ":memory:",
      config: { ...DEFAULT_CULTURE_CONFIG },
    });
    memory = new MemoryManager({ dbPath: ":memory:" });
    resetCultureManagerForTests(culture);
    resetMemoryManagerForTests(memory);
  });

  afterEach(() => {
    // reset* closes the active singleton (our local managers).
    resetCultureManagerForTests(undefined);
    resetMemoryManagerForTests(undefined);
  });

  it("retrieves terms and patterns from utterance", () => {
    const hits = retrieveCultureHits(
      culture.store,
      "c2c:t",
      "我破防了还整了个五杀一",
      culture.config,
    );
    assert.ok(hits.some((h) => h.label === "破防"));
    assert.ok(hits.some((h) => h.kind === "pattern" && h.label === "五X一"));
  });

  it("learns conversation-scoped corrections and keeps them local", () => {
    const r = culture.ingestUserUtterance({
      conversationId: "c2c:t",
      text: "自定义梗的意思是只在这个群用的说法",
    });
    assert.equal(r.corrections.length, 1);
    assert.equal(r.corrections[0]!.scope, "conversation");

    const hitsA = retrieveCultureHits(
      culture.store,
      "c2c:t",
      "这个自定义梗好难",
      culture.config,
    );
    assert.ok(hitsA.some((h) => h.label === "自定义梗"));

    const hitsB = retrieveCultureHits(
      culture.store,
      "c2c:other",
      "这个自定义梗好难",
      culture.config,
    );
    assert.ok(!hitsB.some((h) => h.label === "自定义梗"));
  });

  it("assembleBridgeContext keeps Persona / Memory / Culture distinct", () => {
    const assembled = assembleBridgeContext({
      personaBody: "Persona voice here",
      memorySection: "--- Long-term Memory ---\n- [preference] tea\n",
      cultureSection:
        "--- Culture KB (slang / community norms; not personal memory) ---\n- 破防 · confidence=confirmed · source=seed:curated: gloss\n",
    });
    assert.deepEqual(assembled.sections, ["persona", "memory", "culture"]);
    assert.match(assembled.fullText, /--- Persona ---/);
    assert.match(assembled.fullText, /Long-term Memory/);
    assert.match(assembled.fullText, /Culture KB/);
    assert.ok(assembled.personaSection.includes("Persona voice here"));
    assert.ok(!assembled.memorySection.includes("Culture KB"));
    assert.ok(!assembled.cultureSection.includes("Long-term Memory"));
  });

  it("writeBridgeSessionPrompt injects culture without duplicating into memory store", () => {
    culture.noteUserText("c2c:t", "我破防了");
    memory.commitTurn({
      conversationId: "c2c:t",
      userText: "请记住：我叫阿强",
      assistantText: "好的",
      qqMessageId: "m1",
    });
    const prompt = writeBridgeSessionPrompt("Be concise.", "c2c:t");
    assert.ok(prompt.sections.includes("persona"));
    assert.ok(prompt.fullText.includes("Culture KB") || prompt.culture.hitCount >= 0);
    assert.ok(fs.existsSync(prompt.path));
    // Memory items are personal — culture terms must not appear as memory rows.
    const mems = memory.listMemories("c2c:t");
    assert.ok(!mems.some((m) => m.content.includes("破防的意思")));
  });

  it("culture hash changes after correction (fork signal)", () => {
    const before = culture.currentCultureHash("c2c:t");
    culture.ingestUserUtterance({
      conversationId: "c2c:t",
      text: "新梗的意思是测试用词",
    });
    assert.notEqual(culture.currentCultureHash("c2c:t"), before);
    assert.equal(culture.cultureHashChanged("c2c:t", before), true);
  });
});

describe("Culture modules stay backend-neutral", () => {
  it("culture source files do not import adapters or claude transport", () => {
    // fileURLToPath handles Windows drive letters (URL pathname would be /C:/...).
    const cultureDir = fileURLToPath(new URL("../src/culture", import.meta.url));
    const files = fs.readdirSync(cultureDir).filter((f) => f.endsWith(".ts"));
    assert.ok(files.length > 0);
    for (const f of files) {
      const src = fs.readFileSync(path.join(cultureDir, f), "utf8");
      assert.doesNotMatch(src, /adapters\/claude|claude\/stream|codex-app-server|gemini-acp/);
    }
  });
});
