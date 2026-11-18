/**
 * Bridge-owned per-conversation image interaction state.
 * Complements Bridge recent-actions (IMAGE_SENT) for pending / nudge phrases
 * like「发啊」after an acknowledged-but-not-yet-sent request.
 *
 * Isolated by QQ conversationId. Not Memory / Persona.
 */

export interface ImageSessionState {
  conversationId: string;
  /** Last successfully delivered search subject. */
  lastImageQuery?: string;
  lastImageSentAt?: number;
  /** Subject the Bridge intends to send / was asked to send but not confirmed. */
  pendingImageQuery?: string;
  pendingSetAt?: number;
  /** Prefer a different image when fulfilling pending / batch. */
  pendingPreferDifferent?: boolean;
  pendingCount?: number;
}

const byConversation = new Map<string, ImageSessionState>();

const PENDING_TTL_MS = 15 * 60_000;
const LAST_TTL_MS = 24 * 60_000;

function prune(state: ImageSessionState, now = Date.now()): ImageSessionState {
  if (
    state.pendingSetAt &&
    now - state.pendingSetAt > PENDING_TTL_MS
  ) {
    state.pendingImageQuery = undefined;
    state.pendingSetAt = undefined;
    state.pendingPreferDifferent = undefined;
    state.pendingCount = undefined;
  }
  if (state.lastImageSentAt && now - state.lastImageSentAt > LAST_TTL_MS) {
    state.lastImageQuery = undefined;
    state.lastImageSentAt = undefined;
  }
  return state;
}

function getOrCreate(conversationId: string): ImageSessionState {
  let s = byConversation.get(conversationId);
  if (!s) {
    s = { conversationId };
    byConversation.set(conversationId, s);
  }
  return prune(s);
}

export function getImageSession(conversationId: string): ImageSessionState {
  return { ...getOrCreate(conversationId) };
}

/**
 * Resolve effective last subject.
 * Prefer durable IMAGE_SENT (fromActions) when present so restart/reload and
 * tests that seed Bridge actions stay authoritative; session fills gaps.
 */
export function resolveLastImageQuery(
  conversationId: string,
  fromActions?: string,
): string | undefined {
  const s = getOrCreate(conversationId);
  return fromActions?.trim() || s.lastImageQuery?.trim() || undefined;
}

export function resolvePendingImageQuery(
  conversationId: string,
): string | undefined {
  return getOrCreate(conversationId).pendingImageQuery?.trim();
}

export function setPendingImageRequest(
  conversationId: string,
  query: string,
  opts: { preferDifferent?: boolean; count?: number } = {},
): void {
  const q = query.trim().slice(0, 120);
  if (!q) return;
  const s = getOrCreate(conversationId);
  s.pendingImageQuery = q;
  s.pendingSetAt = Date.now();
  s.pendingPreferDifferent = opts.preferDifferent || undefined;
  s.pendingCount = opts.count && opts.count > 1 ? opts.count : undefined;
}

export function clearPendingImageRequest(conversationId: string): void {
  const s = getOrCreate(conversationId);
  s.pendingImageQuery = undefined;
  s.pendingSetAt = undefined;
  s.pendingPreferDifferent = undefined;
  s.pendingCount = undefined;
}

export function rememberImageDelivered(
  conversationId: string,
  query: string,
): void {
  const q = query.trim().slice(0, 120);
  if (!q) return;
  const s = getOrCreate(conversationId);
  s.lastImageQuery = q;
  s.lastImageSentAt = Date.now();
  clearPendingImageRequest(conversationId);
}

export function clearImageSessionForTests(conversationId?: string): void {
  if (conversationId) byConversation.delete(conversationId);
  else byConversation.clear();
}
