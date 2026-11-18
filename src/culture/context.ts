import crypto from "node:crypto";
import { estimateTokens } from "../memory/tokens.js";
import { retrieveCultureHits } from "./retrieve.js";
import type { CultureStore } from "./store.js";
import type { CultureConfig, CultureContextBundle, CultureHit } from "./types.js";

export function cultureSectionHash(section: string): string {
  return crypto.createHash("sha256").update(section).digest("hex");
}

function formatHit(h: CultureHit): string {
  const bits = [`${h.label}`];
  if (h.matched && h.matched !== h.label) bits.push(`match=${h.matched}`);
  if (h.community) bits.push(`community=${h.community}`);
  bits.push(`confidence=${h.confidence}`);
  bits.push(`source=${h.source}`);
  return `- ${bits.join(" · ")}: ${h.gloss}`;
}

/**
 * Build a bounded Culture KB section for session context injection.
 * Empty string when nothing relevant — callers must not inject empty headers repeatedly.
 */
export function buildCultureContext(
  store: CultureStore,
  conversationId: string,
  config: CultureConfig,
  opts: { queryHints?: string } = {},
): CultureContextBundle {
  if (!config.enabled) {
    return {
      cultureSection: "",
      cultureHash: "disabled",
      estimatedTokens: 0,
      hitCount: 0,
    };
  }

  const query =
    opts.queryHints?.trim() ||
    store.getLastQuery(conversationId) ||
    "";

  const hits = query ? retrieveCultureHits(store, conversationId, query, config) : [];

  if (!hits.length) {
    // Still track profile hash so corrections mid-session can trigger fork.
    const profile = store.profileHash(conversationId);
    return {
      cultureSection: "",
      cultureHash: profile,
      estimatedTokens: 0,
      hitCount: 0,
    };
  }

  const header = [
    "--- Culture KB (slang / community norms; not personal memory) ---",
    "Use only when relevant. Prefer conversation-local corrections over global seed.",
  ];
  const lines: string[] = [...header];
  let tokens = estimateTokens(header.join("\n"));
  let included = 0;

  for (const h of hits) {
    const line = formatHit(h);
    const add = estimateTokens(line);
    if (tokens + add > config.contextBudgetTokens && included > 0) break;
    lines.push(line);
    tokens += add;
    included++;
  }

  const cultureSection = lines.join("\n") + "\n";
  return {
    cultureSection,
    cultureHash: cultureSectionHash(cultureSection + "|" + store.profileHash(conversationId)),
    estimatedTokens: estimateTokens(cultureSection),
    hitCount: included,
  };
}
