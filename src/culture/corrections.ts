/**
 * Deterministic extraction of explicit Culture corrections from user text.
 * No model calls. Conversation-scoped by default unless user asks for global.
 */
import type { CultureCorrection } from "./types.js";

const GLOBAL_CUE =
  /(?:全局|全部会话|所有对话|永久记住|写进(?:文化)?词库|全局记住)/;

/**
 * Detect explicit slang/culture corrections.
 * Examples:
 * - 「破防的意思是情绪崩溃」
 * - 「纠正：绝绝子 = 太绝了」
 * - 「文化库：栓Q 是 thank you 的阴阳」
 * - 「不是摆烂，是主动躺平」 (gloss reframes prior term — weaker; only if clear)
 */
const LEADING_CUE =
  /^(?:请?全局记住|永久记住|写进(?:文化)?词库|全局|纠正|更正|订正)\s*[:：]?\s*/u;

export function extractCultureCorrections(text: string): CultureCorrection[] {
  const t = text.trim();
  if (!t || t.length > 500) return [];
  const makeGlobal = GLOBAL_CUE.test(t);
  const out: CultureCorrection[] = [];

  const patterns: Array<{ re: RegExp; term: number; gloss: number }> = [
    {
      re: /(?:文化库|词库|俚语|梗)\s*[:：]\s*([^\s=：:=]{1,40})\s*[=＝是:：]\s*(.+)$/u,
      term: 1,
      gloss: 2,
    },
    {
      re: /(?:纠正|更正|订正)\s*[:：]?\s*([^\s=：:=]{1,40})\s*[=＝是:：]\s*(.+)$/u,
      term: 1,
      gloss: 2,
    },
    {
      re: /^([A-Za-z\u4e00-\u9fff]{1,20})的意思是\s*(.+)$/u,
      term: 1,
      gloss: 2,
    },
    {
      re: /^([A-Za-z\u4e00-\u9fff]{1,20})\s*[=＝]\s*(.+)$/u,
      term: 1,
      gloss: 2,
    },
    {
      re: /^([A-Za-z\u4e00-\u9fff]{1,20})指的是\s*(.+)$/u,
      term: 1,
      gloss: 2,
    },
    {
      re: /^([A-Za-z\u4e00-\u9fff]{1,20})是指\s*(.+)$/u,
      term: 1,
      gloss: 2,
    },
  ];

  for (const line of t.split(/[\n;；]/)) {
    let s = line.trim();
    if (!s) continue;
    s = s.replace(LEADING_CUE, "").trim();
    if (!s) continue;
    for (const p of patterns) {
      const m = s.match(p.re);
      if (!m) continue;
      const term = cleanTerm(m[p.term] ?? "");
      const gloss = cleanGloss(m[p.gloss] ?? "");
      if (!term || !gloss || term === gloss) continue;
      if (looksSensitive(term) || looksSensitive(gloss)) continue;
      out.push({ term, gloss, makeGlobal, raw: s });
      break;
    }
  }

  return dedupe(out);
}

function cleanTerm(s: string): string {
  return s.replace(/^[\s「」『』“”"'【】\[\]]+|[\s「」『』“”"'【】\[\]]+$/g, "").trim();
}

function cleanGloss(s: string): string {
  return s
    .replace(/^(?:就是|即|指)\s*/u, "")
    .replace(/[。.!！？?]+$/u, "")
    .trim()
    .slice(0, 240);
}

function looksSensitive(s: string): boolean {
  return /password|passwd|secret|token|api[_-]?key|私钥|密码|验证码/i.test(s);
}

function dedupe(items: CultureCorrection[]): CultureCorrection[] {
  const seen = new Set<string>();
  const out: CultureCorrection[] = [];
  for (const c of items) {
    const k = c.term.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}
