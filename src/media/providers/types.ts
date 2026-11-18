import type { ImageSearchHit } from "../types.js";

/** Backend-independent search provider (Openverse, optional stock APIs, …). */
export interface ImageSearchProvider {
  readonly id: string;
  search(opts: {
    queries: string[];
    /** Prefer these Openverse-style source hosts when supported. */
    preferSources?: string[];
    pageSize?: number;
    page?: number;
    timeoutMs?: number;
    /** Stop after collecting this many unique hits. */
    stopAfterHits?: number;
    maxQueries?: number;
  }): Promise<ImageSearchHit[]>;
}

export function dedupeHits(hits: ImageSearchHit[]): ImageSearchHit[] {
  const byId = new Set<string>();
  const byUrl = new Set<string>();
  const out: ImageSearchHit[] = [];
  for (const h of hits) {
    if (byId.has(h.id)) continue;
    const urlKey = h.url.trim().toLowerCase();
    if (byUrl.has(urlKey)) continue;
    byId.add(h.id);
    byUrl.add(urlKey);
    out.push(h);
  }
  return out;
}
