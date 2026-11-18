/**
 * QQ group @bot markers in inbound content.
 *
 * Official bot payloads use `<@OPENID>` / `<@!OPENID>` where OPENID may be
 * numeric or hex — not only the bot appId. SDK `stripBotMention` only removes
 * the appId form, so hex markers survive and break leading `/command` detection.
 */
const QQ_MENTION_MARKER_RE = /<@!?[^>]+>\s*/g;

/**
 * Remove QQ mention markers (and trailing spaces after each).
 * Safe for C2C (no-op when none present) and group @bot prefixes.
 */
export function stripQqMentionMarkers(text: string): string {
  if (!text) return "";
  return text.replace(QQ_MENTION_MARKER_RE, "");
}

/**
 * Normalize inbound QQ text for Bridge routing / agent turns:
 * strip mention markers, then trim.
 */
export function normalizeInboundQqText(text: string): string {
  return stripQqMentionMarkers(text).trim();
}
