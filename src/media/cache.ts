import type { ImageSearchHit } from "./types.js";

interface CacheEntry {
  hits: ImageSearchHit[];
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();

export function cacheKey(provider: string, query: string): string {
  return `${provider}:${query.trim().toLowerCase()}`;
}

export function getCachedHits(key: string): ImageSearchHit[] | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  if (e.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  // Never treat an empty miss as a warm cache entry (transient DDGS failures).
  if (!e.hits.length) {
    store.delete(key);
    return undefined;
  }
  return e.hits;
}

export function setCachedHits(
  key: string,
  hits: ImageSearchHit[],
  ttlMs = 30 * 60_000,
): void {
  // Do not poison the cache with empty results from a flaky provider call.
  if (!hits.length) {
    store.delete(key);
    return;
  }
  store.set(key, { hits, expiresAt: Date.now() + ttlMs });
  // Bound memory
  if (store.size > 200) {
    const first = store.keys().next().value;
    if (first) store.delete(first);
  }
}

export function clearImageSearchCache(): void {
  store.clear();
}
