/**
 * Productive pattern matching (e.g. 五{slot}一 → 五福一).
 */

export type PatternMatch = {
  matched: string;
  slots: string[];
  start: number;
  end: number;
};

/**
 * Convert a `{slot}` template into a regex that captures each slot.
 * Slot = 1–8 CJK / alnum chars (non-greedy toward template literals).
 */
export function templateToRegExp(template: string): RegExp | null {
  const parts = template.split(/\{slot\}/g);
  if (parts.length < 2) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let body = "";
  for (let i = 0; i < parts.length; i++) {
    body += esc(parts[i] ?? "");
    if (i < parts.length - 1) {
      // Non-greedy: avoid "{slot}中{slot}" swallowing past the intended pair (典中典…).
      body += "([\\u4e00-\\u9fffA-Za-z0-9]{1,8}?)";
    }
  }
  try {
    return new RegExp(body, "gu");
  } catch {
    return null;
  }
}

/** Find all non-overlapping matches of template in text. */
export function matchTemplate(template: string, text: string): PatternMatch[] {
  const re = templateToRegExp(template);
  if (!re || !text) return [];
  const out: PatternMatch[] = [];
  for (const m of text.matchAll(re)) {
    const matched = m[0] ?? "";
    if (!matched) continue;
    const slots = m.slice(1).filter((x): x is string => typeof x === "string");
    // X中X: require identical slots when template has two identical {slot} semantics
    if (template === "{slot}中{slot}" && slots.length >= 2 && slots[0] !== slots[1]) {
      continue;
    }
    out.push({
      matched,
      slots,
      start: m.index ?? 0,
      end: (m.index ?? 0) + matched.length,
    });
  }
  return out;
}
