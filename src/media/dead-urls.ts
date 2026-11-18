/**
 * Short-lived memory of image candidates that failed with a hard HTTP error
 * (404/410). Prevents burning download attempts on the same stale Openverse URLs
 * across repeated “再来一张” requests in a conversation.
 */

interface DeadEntry {
  expiresAt: number;
}

const byId = new Map<string, DeadEntry>();
const byUrl = new Map<string, DeadEntry>();

const DEFAULT_TTL_MS = 2 * 60 * 60_000;
const MAX_ENTRIES = 400;

function prune(map: Map<string, DeadEntry>, now: number): void {
  for (const [k, v] of map) {
    if (v.expiresAt <= now) map.delete(k);
  }
  while (map.size > MAX_ENTRIES) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

export function rememberDeadImage(
  opts: { id?: string; url?: string },
  ttlMs = DEFAULT_TTL_MS,
): void {
  const now = Date.now();
  const expiresAt = now + Math.max(60_000, ttlMs);
  if (opts.id) {
    byId.set(opts.id, { expiresAt });
    prune(byId, now);
  }
  if (opts.url) {
    byUrl.set(opts.url, { expiresAt });
    prune(byUrl, now);
  }
}

export function isDeadImage(opts: { id?: string; url?: string }): boolean {
  const now = Date.now();
  if (opts.id) {
    const e = byId.get(opts.id);
    if (e) {
      if (e.expiresAt > now) return true;
      byId.delete(opts.id);
    }
  }
  if (opts.url) {
    const e = byUrl.get(opts.url);
    if (e) {
      if (e.expiresAt > now) return true;
      byUrl.delete(opts.url);
    }
  }
  return false;
}

export function clearDeadImages(): void {
  byId.clear();
  byUrl.clear();
}
