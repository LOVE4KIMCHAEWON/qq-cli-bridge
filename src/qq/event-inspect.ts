import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { dataRoot, ensureDataDirs } from "../paths.js";
import { log } from "../util/logger.js";

/**
 * Privacy-safe inbound event inspection.
 * Never logs plaintext content — only HMAC and structural metadata.
 */

const HASH_KEY_FILE = "event-hash.key";

function hashKey(): Buffer {
  ensureDataDirs();
  const p = path.join(dataRoot(), "secrets", HASH_KEY_FILE);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, crypto.randomBytes(32), { mode: 0o600 });
  }
  return fs.readFileSync(p);
}

/** Stable keyed hash of normalized text for cross-event correlation. */
export function contentCorrelationHash(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return crypto.createHmac("sha256", hashKey()).update(normalized, "utf8").digest("hex").slice(0, 16);
}

export interface RawEventInspection {
  receivedAt: string;
  handlerId?: string;
  rawEventType: string;
  kind: string;
  senderId: string;
  conversationId: string;
  normalizedMessageId: string;
  rawId: string | undefined;
  idsEqual: boolean;
  normalizedMsgIdx?: string;
  rawExt?: string[];
  rawTimestamp?: string;
  normalizedTimestamp?: string;
  timestampsEqual: boolean;
  rawMessageType?: number;
  rawKeyList: string[];
  attachmentCount: number;
  msgElementCount: number;
  contentLen: number;
  contentHash: string;
  messageIdFingerprints: { prefix8: string; suffix8: string; len: number };
  msgIdxFingerprints?: { prefix8: string; suffix8: string; len: number };
}

function fingerprint(id: string | undefined): { prefix8: string; suffix8: string; len: number } | undefined {
  if (!id) return undefined;
  return {
    prefix8: id.slice(0, 8),
    suffix8: id.slice(-8),
    len: id.length,
  };
}

export function inspectInboundMessage(
  msg: QQBotInboundMessage,
  text: string,
  meta: { handlerId?: string; conversationId: string },
): RawEventInspection {
  const raw = (msg.raw ?? {}) as unknown as Record<string, unknown>;
  const scene = (raw.message_scene ?? {}) as { ext?: string[] };
  const rawId = typeof raw.id === "string" ? raw.id : undefined;
  const rawTs = typeof raw.timestamp === "string" ? raw.timestamp : undefined;

  return {
    receivedAt: new Date().toISOString(),
    handlerId: meta.handlerId,
    rawEventType: msg.rawEventType,
    kind: msg.kind,
    senderId: msg.senderId,
    conversationId: meta.conversationId,
    normalizedMessageId: msg.messageId,
    rawId,
    idsEqual: rawId === msg.messageId,
    normalizedMsgIdx: msg.msgIdx,
    rawExt: Array.isArray(scene.ext) ? scene.ext.map(String) : undefined,
    rawTimestamp: rawTs,
    normalizedTimestamp: msg.timestamp,
    timestampsEqual: rawTs === msg.timestamp,
    rawMessageType: typeof raw.message_type === "number" ? raw.message_type : undefined,
    rawKeyList: Object.keys(raw).sort(),
    attachmentCount: Array.isArray(raw.attachments) ? raw.attachments.length : 0,
    msgElementCount: Array.isArray(raw.msg_elements) ? raw.msg_elements.length : 0,
    contentLen: text.length,
    contentHash: contentCorrelationHash(text),
    messageIdFingerprints: fingerprint(msg.messageId)!,
    msgIdxFingerprints: fingerprint(msg.msgIdx),
  };
}

export function logInboundInspection(inspection: RawEventInspection): void {
  log.info("event:raw_inspect", inspection);
  console.log("[qqbridge:event]", JSON.stringify(inspection));
  appendEventJournal(inspection);
}

/** Append-only JSONL journal for offline 1:1 correlation experiments. */
export function appendEventJournal(inspection: RawEventInspection): void {
  ensureDataDirs();
  const journal = path.join(dataRoot(), "logs", "inbound-events.jsonl");
  fs.appendFileSync(journal, JSON.stringify(inspection) + "\n", "utf8");
}

/** Describe how the SDK maps C2C raw → normalized (for docs/tests). */
export function describeC2cIdentityMapping(): string {
  return [
    "C2C_MESSAGE_CREATE raw.d.id            → InboundMessage.messageId",
    "C2C_MESSAGE_CREATE raw.d.timestamp     → InboundMessage.timestamp",
    "C2C_MESSAGE_CREATE raw.d.author.user_openid → InboundMessage.senderId",
    "C2C_MESSAGE_CREATE raw.d.message_scene.ext msg_idx=… → InboundMessage.msgIdx",
    "No alternate C2C event type maps to the same message listener path.",
    "Gateway DISPATCH seq (s) is NOT forwarded to onMessage by qqbot-nodejs.",
  ].join("\n");
}
