import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseImageIntent } from "../src/media/index.js";
import {
  PERSONA_BRIDGE_MEDIA_FRAMING,
  PERSONA_SYSTEM_FRAMING_CLAUDE,
  PERSONA_SYSTEM_FRAMING_CODEX_RESTRICTED,
} from "../src/persona/default.js";

describe("NL image intent — positive requests", () => {
  it("handles 有没有…合照 and soft visual asks", () => {
    const a = parseImageIntent("有没有newjeans五人合照");
    assert.equal(a.kind, "search");
    if (a.kind === "search") {
      assert.match(a.query, /newjeans/i);
      assert.match(a.query, /五人合照/);
      assert.equal(a.preferDifferent, true);
    }

    const b = parseImageIntent("想看看Minji的机场照");
    assert.equal(b.kind, "search");
    if (b.kind === "search") {
      assert.match(b.query, /Minji/i);
      assert.match(b.query, /机场照/);
      assert.doesNotMatch(b.query, /想看/);
    }

    const c = parseImageIntent("给我找点Hanni的舞台图");
    assert.equal(c.kind, "search");
    if (c.kind === "search") {
      assert.match(c.query, /Hanni/i);
      assert.match(c.query, /舞台/);
    }

    assert.deepEqual(parseImageIntent("来张范玉欣"), {
      kind: "search",
      query: "范玉欣",
    });
    assert.deepEqual(parseImageIntent("来张newjeans"), {
      kind: "search",
      query: "newjeans",
    });
  });
});

describe("NL image intent — multi-turn follow-ups preserve subject", () => {
  const ctx = { lastImageQuery: "newjeans" };

  it("merges scene modifiers onto last subject", () => {
    const a = parseImageIntent("有没有五人合照", ctx);
    assert.equal(a.kind, "search");
    if (a.kind === "search") {
      assert.match(a.query, /newjeans/i);
      assert.match(a.query, /五人合照/);
      assert.equal(a.preferDifferent, true);
    }

    const b = parseImageIntent("有那种五个人一起拍的吗", ctx);
    assert.equal(b.kind, "search");
    if (b.kind === "search") {
      assert.match(b.query, /newjeans/i);
      assert.match(b.query, /五人合照/);
      assert.doesNotMatch(b.query, /^五人合照$/);
      assert.equal(b.preferDifferent, true);
    }
  });

  it("keeps last subject for quality / quantity follow-ups", () => {
    assert.deepEqual(parseImageIntent("来张更清晰的", ctx), {
      kind: "search",
      query: "newjeans",
      preferDifferent: true,
    });
    assert.deepEqual(parseImageIntent("再来几张", ctx), {
      kind: "search",
      query: "newjeans",
      preferDifferent: true,
      count: 2,
    });
    assert.deepEqual(parseImageIntent("换一张", ctx), {
      kind: "search",
      query: "newjeans",
      preferDifferent: true,
    });
  });

  it("does not invent a subject without lastImageQuery", () => {
    assert.equal(parseImageIntent("有没有五人合照").kind, "none");
    assert.equal(parseImageIntent("来张更清晰的").kind, "none");
    assert.equal(parseImageIntent("再来几张").kind, "none");
    assert.equal(parseImageIntent("有那种五个人一起拍的吗").kind, "none");
    assert.equal(parseImageIntent("换一张").kind, "none");
    assert.equal(parseImageIntent("换一批").kind, "none");
    assert.equal(parseImageIntent("发啊").kind, "none");
  });
});

describe("NL image intent — negative / factual stay with Agent", () => {
  it("leaves ordinary questions as none", () => {
    for (const phrase of [
      "NewJeans出道哪年",
      "newjeans有几个人",
      "这张图是谁拍的",
      "合照是什么意思",
      "Minji几岁了",
      "你好啊",
      "今天天气怎么样",
      "整个人都不好了",
    ] as const) {
      assert.equal(
        parseImageIntent(phrase, { lastImageQuery: "newjeans" }).kind,
        "none",
        phrase,
      );
    }
  });
});

describe("Bridge media framing — no /image coaching", () => {
  it("describes natural-language Bridge search and forbids slash coaching", () => {
    assert.match(PERSONA_BRIDGE_MEDIA_FRAMING, /natural language/i);
    assert.match(PERSONA_BRIDGE_MEDIA_FRAMING, /Do not tell the user to type slash commands/i);
    assert.doesNotMatch(PERSONA_BRIDGE_MEDIA_FRAMING, /or \/image/);
    assert.match(PERSONA_SYSTEM_FRAMING_CLAUDE, /Do not tell the user to type slash commands/i);
    assert.match(
      PERSONA_SYSTEM_FRAMING_CODEX_RESTRICTED,
      /Do not tell the user to type slash commands/i,
    );
  });
});
