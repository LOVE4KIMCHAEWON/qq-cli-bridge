import fs from "node:fs";
import path from "node:path";
import { dataRoot, ensureDataDirs } from "../paths.js";
import type { AgentKind } from "../types.js";

export interface ConversationModelState {
  /** undefined / omitted means CLI default */
  modelId?: string;
  backend: AgentKind;
  updatedAt: string;
}

interface StoreFile {
  v: 1;
  conversations: Record<string, ConversationModelState>;
}

function storePath(): string {
  return path.join(dataRoot(), "state", "conversation-models.json");
}

function readStore(): StoreFile {
  ensureDataDirs();
  const p = storePath();
  if (!fs.existsSync(p)) return { v: 1, conversations: {} };
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as StoreFile;
  } catch {
    return { v: 1, conversations: {} };
  }
}

function writeStore(store: StoreFile): void {
  ensureDataDirs();
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf8");
}

export function getConversationModel(
  conversationId: string,
): ConversationModelState | undefined {
  return readStore().conversations[conversationId];
}

export function setConversationModel(
  conversationId: string,
  backend: AgentKind,
  modelId: string | undefined,
): void {
  const store = readStore();
  store.conversations[conversationId] = {
    backend,
    modelId,
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
}

export function clearConversationModel(conversationId: string): void {
  const store = readStore();
  const cur = store.conversations[conversationId];
  if (!cur) return;
  store.conversations[conversationId] = {
    ...cur,
    modelId: undefined,
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
}
