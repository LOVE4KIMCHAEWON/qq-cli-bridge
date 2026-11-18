/**
 * Bounded Bridge action log per QQ conversation.
 * Survives Bridge restarts; not Memory / Culture; no Agent tools.
 */
import fs from "node:fs";
import path from "node:path";
import { dataRoot, ensureDataDirs } from "../paths.js";

export type BridgeActionKind = "image_search_send";

export type BridgeActionStatus =
  | "sent"
  | "send_failed"
  | "search_failed"
  | "disabled";

export interface BridgeActionRecord {
  id: string;
  at: string;
  kind: BridgeActionKind;
  status: BridgeActionStatus;
  conversationId: string;
  /** User search subject / query. */
  query: string;
  title?: string;
  provider?: string;
  imageId?: string;
  attribution?: string;
  error?: string;
  /** True only when QQ delivery confirmed. */
  delivered: boolean;
}

interface StoreFile {
  v: 1;
  /** conversationId → newest-first ring */
  byConversation: Record<string, BridgeActionRecord[]>;
}

const MAX_PER_CONV = 8;
const TTL_MS = 24 * 60 * 60_000;

function storePath(): string {
  return path.join(dataRoot(), "state", "bridge-recent-actions.json");
}

function readStore(): StoreFile {
  ensureDataDirs();
  const p = storePath();
  if (!fs.existsSync(p)) return { v: 1, byConversation: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as StoreFile;
    if (!raw || raw.v !== 1 || typeof raw.byConversation !== "object") {
      return { v: 1, byConversation: {} };
    }
    return raw;
  } catch {
    return { v: 1, byConversation: {} };
  }
}

function writeStore(store: StoreFile): void {
  ensureDataDirs();
  const tmp = storePath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, storePath());
}

function pruneList(list: BridgeActionRecord[]): BridgeActionRecord[] {
  const cutoff = Date.now() - TTL_MS;
  return list
    .filter((a) => {
      const t = Date.parse(a.at);
      return Number.isFinite(t) && t >= cutoff;
    })
    .slice(0, MAX_PER_CONV);
}

function newId(): string {
  return `ba_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function recordBridgeAction(
  input: Omit<BridgeActionRecord, "id" | "at" | "delivered"> & {
    delivered?: boolean;
    at?: string;
  },
): BridgeActionRecord {
  const record: BridgeActionRecord = {
    id: newId(),
    at: input.at ?? new Date().toISOString(),
    kind: input.kind,
    status: input.status,
    conversationId: input.conversationId,
    query: input.query.slice(0, 120),
    title: input.title?.slice(0, 80),
    provider: input.provider,
    imageId: input.imageId,
    attribution: input.attribution?.slice(0, 160),
    error: input.error?.slice(0, 160),
    delivered:
      input.delivered ??
      (input.status === "sent"),
  };
  // Never mark delivered on failure paths.
  if (record.status !== "sent") record.delivered = false;

  const store = readStore();
  const prev = store.byConversation[input.conversationId] ?? [];
  store.byConversation[input.conversationId] = pruneList([record, ...prev]);
  // Bound total conversations
  const keys = Object.keys(store.byConversation);
  if (keys.length > 200) {
    for (const k of keys.slice(0, keys.length - 200)) {
      delete store.byConversation[k];
    }
  }
  writeStore(store);
  return record;
}

export function listBridgeActions(
  conversationId: string,
): BridgeActionRecord[] {
  const store = readStore();
  const list = pruneList(store.byConversation[conversationId] ?? []);
  if (list.length !== (store.byConversation[conversationId] ?? []).length) {
    store.byConversation[conversationId] = list;
    writeStore(store);
  }
  return list;
}

/**
 * Most recent successfully delivered image search subject in this conversation.
 * Used to resolve “她 / 这张 / 换一张” follow-ups without a new memory DB.
 */
export function lastDeliveredImageQuery(
  conversationId: string,
): string | undefined {
  const sent = listBridgeActions(conversationId).find(
    (a) =>
      a.kind === "image_search_send" &&
      a.status === "sent" &&
      a.delivered &&
      a.query.trim().length > 0,
  );
  return sent?.query.trim();
}

/**
 * Compact section for system prompt (session start / rotation).
 * Empty string when nothing recent.
 */
export function formatBridgeActionsSection(conversationId: string): string {
  const actions = listBridgeActions(conversationId);
  if (!actions.length) return "";
  const lines = actions.slice(0, 5).map((a, i) => formatActionLine(i + 1, a));
  return [
    "## Bridge recent actions (not Memory; Bridge-operated; trust these facts)",
    ...lines,
    "",
  ].join("\n");
}

/**
 * Per-turn prefix for the model. Distinct marker so Memory commit can omit it.
 * Do not invent actions beyond this list.
 */
export function formatBridgeActionsTurnNote(conversationId: string): string {
  const actions = listBridgeActions(conversationId);
  if (!actions.length) return "";
  const lines = actions.slice(0, 5).map((a, i) => formatActionLine(i + 1, a));
  return [
    "[Bridge actions — not your tools. The QQ Bridge may search/send openly licensed images on your behalf. Trust only the facts below; do not claim you cannot send images if a sent action is listed. Do not invent sends that are missing or marked failed.]",
    ...lines,
  ].join("\n");
}

function formatActionLine(n: number, a: BridgeActionRecord): string {
  const when = a.at.replace(/\.\d{3}Z$/, "Z");
  if (a.status === "sent" && a.delivered) {
    const title = a.title ? ` title="${a.title}"` : "";
    const attr = a.attribution ? ` attr=${JSON.stringify(a.attribution.slice(0, 80))}` : "";
    return `${n}. [${when}] IMAGE_SENT query=${JSON.stringify(a.query)}${title} provider=${a.provider ?? "openverse"}${attr}`;
  }
  if (a.status === "send_failed") {
    return `${n}. [${when}] IMAGE_SEND_FAILED query=${JSON.stringify(a.query)} error=${JSON.stringify(a.error ?? "send failed")}`;
  }
  if (a.status === "search_failed") {
    return `${n}. [${when}] IMAGE_SEARCH_FAILED query=${JSON.stringify(a.query)} error=${JSON.stringify(a.error ?? "no result")}`;
  }
  return `${n}. [${when}] IMAGE_${a.status.toUpperCase()} query=${JSON.stringify(a.query)}`;
}

/** True if text starts with our per-turn Bridge actions marker. */
export function isBridgeActionsTurnNote(text: string): boolean {
  return text.trimStart().startsWith("[Bridge actions —");
}

/** Strip per-turn Bridge actions note from a model prompt (for Memory archival). */
export function stripBridgeActionsTurnNote(text: string): string {
  const trimmed = text.trimStart();
  if (!isBridgeActionsTurnNote(trimmed)) return text;
  const nl = trimmed.indexOf("\n\n");
  if (nl >= 0) return trimmed.slice(nl + 2);
  // Single-block note with no blank line: drop lines until a non-list line after header
  const lines = trimmed.split("\n");
  let i = 1;
  while (i < lines.length && /^\d+\.\s/.test(lines[i]!)) i += 1;
  return lines.slice(i).join("\n").trimStart();
}

export function clearBridgeActionsForTests(): void {
  const store = readStore();
  store.byConversation = {};
  writeStore(store);
}

export function resetBridgeActionsStoreFileForTests(): void {
  try {
    fs.rmSync(storePath(), { force: true });
  } catch {
    // ignore
  }
}
