/**
 * Conservative token estimates (no tokenizer dependency).
 * ~4 chars/token for Latin; denser for CJK — use 2.5 chars/token blended.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff)
    ) {
      cjk++;
    } else if (!/\s/.test(ch)) {
      other++;
    }
  }
  return Math.max(1, Math.ceil(cjk / 1.5 + other / 4));
}

export function estimateTokensMany(parts: string[]): number {
  return parts.reduce((n, p) => n + estimateTokens(p), 0);
}
