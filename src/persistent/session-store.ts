import fs from "node:fs";
import path from "node:path";
import { dataRoot, ensureDataDirs } from "../paths.js";

/** Keep in sync with CHAT_ONLY_POLICY_VERSION in security/chat-only.ts (avoid circular import). */
const CHAT_ONLY_POLICY_VERSION = 1;

/** Transport-tagged persistent session entries (never mixed with oneshot ids). */
export type PersistentTransport =
  | "acp"
  | "claude-stream"
  | "codex-app-server"
  | "gemini-acp";

export interface PersistentConversationSession {
  /** Backend-native session / thread id */
  sessionId: string;
  cwd: string;
  modelId?: string;
  /** SHA-256 of Persona body applied when this session was (re)started. */
  personaHash?: string;
  /**
   * Backend capability framing key (e.g. Codex restricted websearch-v2).
   * Mismatch → do not resume (stale "no tools" instructions).
   */
  capabilityKey?: string;
  /** Must match CHAT_ONLY_POLICY_VERSION or session is not resumed. */
  chatOnlyVersion?: number;
  updatedAt: string;
}

interface StoreFile {
  v: 1;
  transport: PersistentTransport;
  chatOnlyVersion: number;
  conversations: Record<string, PersistentConversationSession>;
}

function storePath(transport: PersistentTransport): string {
  const file =
    transport === "acp"
      ? "acp-sessions.json"
      : transport === "claude-stream"
        ? "claude-stream-sessions.json"
        : transport === "codex-app-server"
          ? "codex-app-server-sessions.json"
          : "gemini-acp-sessions.json";
  return path.join(dataRoot(), "state", file);
}

function emptyStore(transport: PersistentTransport): StoreFile {
  return {
    v: 1,
    transport,
    chatOnlyVersion: CHAT_ONLY_POLICY_VERSION,
    conversations: {},
  };
}

function readStore(transport: PersistentTransport): StoreFile {
  ensureDataDirs();
  const p = storePath(transport);
  if (!fs.existsSync(p)) {
    return emptyStore(transport);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as StoreFile;
    if (raw.transport !== transport) {
      return emptyStore(transport);
    }
    return raw;
  } catch {
    return emptyStore(transport);
  }
}

function writeStore(transport: PersistentTransport, store: StoreFile): void {
  ensureDataDirs();
  store.chatOnlyVersion = CHAT_ONLY_POLICY_VERSION;
  fs.writeFileSync(storePath(transport), JSON.stringify(store, null, 2), "utf8");
}

export function getPersistentSession(
  transport: PersistentTransport,
  conversationId: string,
): PersistentConversationSession | undefined {
  return readStore(transport).conversations[conversationId];
}

export function setPersistentSession(
  transport: PersistentTransport,
  conversationId: string,
  entry: Omit<PersistentConversationSession, "updatedAt" | "chatOnlyVersion"> & {
    updatedAt?: string;
    chatOnlyVersion?: number;
  },
): void {
  const store = readStore(transport);
  store.conversations[conversationId] = {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    modelId: entry.modelId,
    personaHash: entry.personaHash,
    chatOnlyVersion: entry.chatOnlyVersion ?? CHAT_ONLY_POLICY_VERSION,
    updatedAt: entry.updatedAt ?? new Date().toISOString(),
  };
  writeStore(transport, store);
}

export function clearPersistentSession(
  transport: PersistentTransport,
  conversationId: string,
): void {
  const store = readStore(transport);
  if (!(conversationId in store.conversations)) return;
  delete store.conversations[conversationId];
  writeStore(transport, store);
}

export function clearAllPersistentSessions(transport: PersistentTransport): void {
  writeStore(transport, emptyStore(transport));
}
