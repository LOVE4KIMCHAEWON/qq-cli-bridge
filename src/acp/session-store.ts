import fs from "node:fs";
import path from "node:path";
import { dataRoot, ensureDataDirs } from "../paths.js";

/** Keep in sync with CHAT_ONLY_POLICY_VERSION in security/chat-only.ts (avoid circular import). */
const CHAT_ONLY_POLICY_VERSION = 1;

export interface AcpConversationSession {
  /** ACP session id from session/new or session/load */
  acpSessionId: string;
  cwd: string;
  /** Last model applied via set_config_option (if any) */
  modelId?: string;
  /** Must match CHAT_ONLY_POLICY_VERSION or session is not resumed. */
  chatOnlyVersion?: number;
  updatedAt: string;
}

interface StoreFile {
  v: 1;
  /** Explicit: oneshot CLI session ids are never stored here. */
  transport: "acp";
  chatOnlyVersion: number;
  conversations: Record<string, AcpConversationSession>;
}

function storePath(): string {
  return path.join(dataRoot(), "state", "acp-sessions.json");
}

function emptyStore(): StoreFile {
  return {
    v: 1,
    transport: "acp",
    chatOnlyVersion: CHAT_ONLY_POLICY_VERSION,
    conversations: {},
  };
}

function readStore(): StoreFile {
  ensureDataDirs();
  const p = storePath();
  if (!fs.existsSync(p)) {
    return emptyStore();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as StoreFile;
    if (raw.transport !== "acp") {
      return emptyStore();
    }
    return raw;
  } catch {
    return emptyStore();
  }
}

function writeStore(store: StoreFile): void {
  ensureDataDirs();
  store.chatOnlyVersion = CHAT_ONLY_POLICY_VERSION;
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf8");
}

export function getAcpSession(
  conversationId: string,
): AcpConversationSession | undefined {
  return readStore().conversations[conversationId];
}

export function setAcpSession(
  conversationId: string,
  entry: Omit<AcpConversationSession, "updatedAt" | "chatOnlyVersion"> & {
    updatedAt?: string;
    chatOnlyVersion?: number;
  },
): void {
  const store = readStore();
  store.conversations[conversationId] = {
    acpSessionId: entry.acpSessionId,
    cwd: entry.cwd,
    modelId: entry.modelId,
    chatOnlyVersion: entry.chatOnlyVersion ?? CHAT_ONLY_POLICY_VERSION,
    updatedAt: entry.updatedAt ?? new Date().toISOString(),
  };
  writeStore(store);
}

export function clearAcpSession(conversationId: string): void {
  const store = readStore();
  if (!(conversationId in store.conversations)) return;
  delete store.conversations[conversationId];
  writeStore(store);
}

export function listAcpSessions(): Record<string, AcpConversationSession> {
  return { ...readStore().conversations };
}

export function clearAllAcpSessions(): void {
  writeStore(emptyStore());
}
