import type { InboundImageAttachment } from "./types.js";

/** Minimal attachment shape from QQ inbound messages (SDK InboundAttachment). */
export interface QqInboundAttachmentLike {
  content_type: string;
  url: string;
  filename?: string;
  height?: number;
  width?: number;
  size?: number;
}

const IMAGE_MIME_RE = /^image\//i;

/**
 * Extract image attachments from a QQ inbound message.
 * Does not download or inspect pixels.
 */
export function extractInboundImages(
  attachments: QqInboundAttachmentLike[] | undefined | null,
): InboundImageAttachment[] {
  if (!attachments?.length) return [];
  const out: InboundImageAttachment[] = [];
  for (const a of attachments) {
    const ct = (a.content_type || "").trim();
    if (!IMAGE_MIME_RE.test(ct) && !/\.(jpe?g|png|gif|webp)(\?|$)/i.test(a.url || "")) {
      continue;
    }
    if (!a.url || !/^https?:\/\//i.test(a.url)) continue;
    out.push({
      contentType: ct || "image/unknown",
      url: a.url,
      filename: a.filename,
      width: a.width,
      height: a.height,
      size: a.size,
    });
  }
  return out;
}

export function isSupportedInboundImageMime(contentType: string): boolean {
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  return (
    base === "image/jpeg" ||
    base === "image/jpg" ||
    base === "image/png" ||
    base === "image/webp" ||
    base === "image/gif"
  );
}

/**
 * Chat-only Claude/Codex backends in this Bridge do not have a verified
 * multimodal image-inspection path. Never invent descriptions.
 */
export function backendCanInspectImages(_backendKind?: string): boolean {
  return false;
}

/** Honest user-facing note when an image arrived but cannot be inspected. */
export function imageReceivedAckText(count: number): string {
  const n = Math.max(1, count);
  return (
    `收到${n}张图片。当前 Chat-only 模式还不能识别图片内容，请用文字说明你想做什么` +
    `（例如「来张猫猫图」「有没有猫猫表情包」），也可以继续纯文字聊天。`
  );
}

/**
 * Text passed to the LLM when images were present but not inspectable.
 * Keeps sender context without claiming vision.
 */
export function imagePresenceNoteForModel(count: number): string {
  return (
    `[系统提示：用户本回合附带了 ${count} 张图片。` +
    `当前后端无法查看图片像素内容，请勿编造图片描述；仅根据用户文字回复。]`
  );
}
