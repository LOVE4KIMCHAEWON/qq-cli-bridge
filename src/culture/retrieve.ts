import type { CultureHit, CultureConfig } from "./types.js";
import type { CultureStore } from "./store.js";

const CONF_SCORE: Record<string, number> = {
  confirmed: 40,
  community_local: 25,
  plausible: 15,
  unknown: 5,
};

/**
 * Lightweight retrieval: terms present in query + productive pattern hits.
 * Token budget applied later in context formatter.
 */
export function retrieveCultureHits(
  store: CultureStore,
  conversationId: string,
  query: string,
  config: CultureConfig,
): CultureHit[] {
  if (!config.enabled) return [];
  const q = query.trim();
  if (!q) return [];

  const hits: CultureHit[] = [];
  const seen = new Set<string>();

  const terms = store.searchTermsInText(conversationId, q, config.maxSnippets);
  for (const t of terms) {
    const key = `term:${t.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      kind: "term",
      id: t.id,
      label: t.term,
      gloss: t.gloss,
      community: t.community,
      confidence: t.confidence,
      source: t.source,
      sourceNote: t.sourceNote,
      score: CONF_SCORE[t.confidence] + t.term.length,
    });
  }

  const patterns = store.matchPatternsInText(conversationId, q, config.maxSnippets);
  for (const p of patterns) {
    const key = `pat:${p.pattern.id}:${p.matched}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      kind: "pattern",
      id: p.pattern.id,
      label: p.pattern.name,
      gloss: p.pattern.gloss,
      community: p.pattern.community,
      confidence: p.pattern.confidence,
      source: p.pattern.source,
      sourceNote: p.pattern.sourceNote,
      matched: p.matched,
      score: CONF_SCORE[p.pattern.confidence] + 30,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, config.maxSnippets);
}
