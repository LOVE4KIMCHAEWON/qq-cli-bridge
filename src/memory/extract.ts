import type { MemoryKind } from "./types.js";

export interface ExtractedMemory {
  kind: MemoryKind;
  content: string;
}

/** Block obvious secrets / PII from permanent memory by default. */
const SENSITIVE =
  /(\b\d{15,19}\b)|(\b\d{3}-\d{2}-\d{4}\b)|(password\s*[:=])|(密码\s*[：:=])|(api[_-]?key)|(secret\s*[:=])|(Bearer\s+[A-Za-z0-9\-._~+/]+=*)|(\b1[3-9]\d{9}\b)|(身份证)|(\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b)/i;

export function looksSensitive(text: string): boolean {
  return SENSITIVE.test(text);
}

const RULES: Array<{ kind: MemoryKind; re: RegExp; take: (m: RegExpMatchArray, raw: string) => string | undefined }> = [
  {
    kind: "preference",
    re: /(?:请记住|记住|remember(?:\s+that)?)\s*[:：]?\s*(.+)$/i,
    take: (_m, raw) => {
      const body = raw.replace(/^(?:请记住|记住|remember(?:\s+that)?)\s*[:：]?\s*/i, "").trim();
      return body || undefined;
    },
  },
  {
    kind: "preference",
    re: /(?:我喜欢|我爱|我更喜欢|我偏好|i\s+(?:like|love|prefer))\s+(.+)/i,
    take: (m) => m[1]?.trim(),
  },
  {
    kind: "preference",
    re: /(?:以后不要|别再|不要再|please\s+don'?t|do\s+not)\s+(.+)/i,
    take: (m) => {
      const body = m[1]?.trim();
      return body ? `Avoid: ${body}` : undefined;
    },
  },
  {
    kind: "preference",
    re: /(?:请叫我|叫我|我叫|我的名字是|my\s+name\s+is|call\s+me)\s*(.+)/i,
    take: (m) => {
      const body = m[1]?.trim().replace(/[。.!！].*$/, "").trim();
      return body ? `Preferred name: ${body}` : undefined;
    },
  },
  {
    kind: "plan",
    re: /(?:我打算|我计划|准备去|i\s+plan\s+to|i'?m\s+going\s+to)\s+(.+)/i,
    take: (m) => {
      const body = m[1]?.trim();
      return body ? `Plan: ${body}` : undefined;
    },
  },
  {
    kind: "correction",
    re: /(?:不对|说错了|纠正一下|actually|correction)\s*[:：,]?\s*(.+)$/i,
    take: (m) => m[1]?.trim(),
  },
  {
    kind: "fact",
    re: /(?:我是|i\s+am|i'?m)\s+(.{2,40})$/i,
    take: (m) => {
      const body = m[1]?.trim();
      if (!body || /^(?:a|an|the)\s+(?:bot|ai|assistant)/i.test(body)) return undefined;
      return `User is: ${body}`;
    },
  },
];

/**
 * Deterministic extraction from a single user utterance.
 * Does not call a model. Skips sensitive / trivial lines.
 */
export function extractMemoriesFromUserText(text: string): ExtractedMemory[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 4) return [];
  if (looksSensitive(trimmed)) return [];
  if (/^[\/!]/.test(trimmed)) return []; // slash commands

  const out: ExtractedMemory[] = [];
  const seen = new Set<string>();

  for (const rule of RULES) {
    const m = trimmed.match(rule.re);
    if (!m) continue;
    const content = rule.take(m, trimmed);
    if (!content || content.length < 2 || content.length > 240) continue;
    if (looksSensitive(content)) continue;
    const key = `${rule.kind}:${content.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: rule.kind, content });
  }

  return out;
}

/** Normalize for duplicate detection across memory items. */
export function normalizeMemoryKey(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}
