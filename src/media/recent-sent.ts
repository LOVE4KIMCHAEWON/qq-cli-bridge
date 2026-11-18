/** Per-conversation recently sent image ids (duplicate avoidance). */
const recent = new Map<string, { ids: string[]; expiresAt: number }>();

const TTL_MS = 60 * 60_000;
const MAX_PER_CONV = 20;

export function rememberSentImage(conversationId: string, imageId: string): void {
  const now = Date.now();
  const cur = recent.get(conversationId);
  const ids = cur && cur.expiresAt > now ? [...cur.ids] : [];
  if (!ids.includes(imageId)) ids.push(imageId);
  while (ids.length > MAX_PER_CONV) ids.shift();
  recent.set(conversationId, { ids, expiresAt: now + TTL_MS });
}

export function recentlySentIds(conversationId: string): Set<string> {
  const cur = recent.get(conversationId);
  if (!cur || cur.expiresAt < Date.now()) {
    recent.delete(conversationId);
    return new Set();
  }
  return new Set(cur.ids);
}

export function clearRecentlySent(): void {
  recent.clear();
}
