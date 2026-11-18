import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { memoryDbPath, ensureDataDirs } from "../paths.js";
import { log } from "../util/logger.js";
import { normalizeMemoryKey } from "./extract.js";
import type { MemoryItem, MemoryKind, StoredTurn } from "./types.js";

export type MemoryStoreOptions = {
  /** Absolute DB path, or `:memory:` for tests. */
  dbPath?: string;
};

/**
 * SQLite-backed archive + memory profile store (Bridge-owned).
 * Model never gets a path to this file.
 */
export class MemoryStore {
  readonly dbPath: string;
  private db: DatabaseSync;

  constructor(opts: MemoryStoreOptions = {}) {
    if (opts.dbPath === ":memory:") {
      this.dbPath = ":memory:";
      this.db = new DatabaseSync(":memory:");
    } else {
      ensureDataDirs();
      this.dbPath = opts.dbPath ?? memoryDbPath();
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      this.db = new DatabaseSync(this.dbPath);
      try {
        fs.chmodSync(this.dbPath, 0o600);
      } catch {
        // Windows may ignore chmod; application-level separation still applies.
      }
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        target_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL,
        qq_message_id TEXT,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_qq_msg
        ON turns(conversation_id, qq_message_id)
        WHERE qq_message_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_turns_conv_id
        ON turns(conversation_id, id);

      CREATE TABLE IF NOT EXISTS memory_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        content_key TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'deterministic',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        superseded_by INTEGER,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_conv_active
        ON memory_items(conversation_id, active, id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_conv_key_active
        ON memory_items(conversation_id, content_key)
        WHERE active = 1;

      CREATE TABLE IF NOT EXISTS maintenance_state (
        conversation_id TEXT PRIMARY KEY,
        last_processed_turn_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_metrics (
        conversation_id TEXT PRIMARY KEY,
        claude_session_id TEXT,
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        turn_count INTEGER NOT NULL DEFAULT 0,
        memory_hash TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        content,
        conversation_id UNINDEXED,
        item_id UNINDEXED
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
        content,
        conversation_id UNINDEXED,
        turn_id UNINDEXED,
        role UNINDEXED
      );
    `);
  }

  ensureConversation(conversationId: string): void {
    const now = new Date().toISOString();
    const parts = conversationId.split(":");
    const scope = parts[0] || "c2c";
    const targetId = parts.slice(1).join(":") || conversationId;
    this.db
      .prepare(
        `INSERT INTO conversations (id, scope, target_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(conversationId, scope, targetId, now, now);
  }

  private hashContent(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 32);
  }

  /**
   * Insert a turn. Returns null if deduped (same qq_message_id).
   * Uses a transaction for crash-safe commit of pairs when used via commitTurnPair.
   */
  insertTurn(input: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    qqMessageId?: string;
  }): StoredTurn | null {
    this.ensureConversation(input.conversationId);
    const now = new Date().toISOString();
    const contentHash = this.hashContent(`${input.role}:${input.content}`);
    try {
      const result = this.db
        .prepare(
          `INSERT INTO turns (conversation_id, role, content, qq_message_id, content_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.conversationId,
          input.role,
          input.content,
          input.qqMessageId ?? null,
          contentHash,
          now,
        );
      const id = Number(result.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO turns_fts (content, conversation_id, turn_id, role) VALUES (?, ?, ?, ?)`,
        )
        .run(input.content, input.conversationId, id, input.role);
      return {
        id,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        qqMessageId: input.qqMessageId,
        createdAt: now,
      };
    } catch (err) {
      const msg = (err as Error).message || "";
      if (/UNIQUE/i.test(msg)) {
        log.info("memory:turn_deduped", {
          conversationId: input.conversationId,
          // never log message body
          hasMessageId: !!input.qqMessageId,
        });
        return null;
      }
      throw err;
    }
  }

  /** Atomic user+assistant pair (assistant always stored if user was new or already present). */
  commitTurnPair(input: {
    conversationId: string;
    userText: string;
    assistantText: string;
    qqMessageId?: string;
  }): { user: StoredTurn | null; assistant: StoredTurn | null; deduped: boolean } {
    this.ensureConversation(input.conversationId);
    const tx = this.db.prepare("BEGIN IMMEDIATE");
    const commit = this.db.prepare("COMMIT");
    const rollback = this.db.prepare("ROLLBACK");
    tx.run();
    try {
      const user = this.insertTurn({
        conversationId: input.conversationId,
        role: "user",
        content: input.userText,
        qqMessageId: input.qqMessageId,
      });
      const deduped = user === null;
      // Still record assistant if this was a new user turn; skip both if inbound deduped.
      let assistant: StoredTurn | null = null;
      if (!deduped) {
        assistant = this.insertTurn({
          conversationId: input.conversationId,
          role: "assistant",
          content: input.assistantText,
        });
      }
      commit.run();
      return { user, assistant, deduped };
    } catch (err) {
      try {
        rollback.run();
      } catch {
        // ignore
      }
      throw err;
    }
  }

  recentTurns(conversationId: string, limit: number): StoredTurn[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id AS conversationId, role, content,
                qq_message_id AS qqMessageId, created_at AS createdAt
         FROM turns
         WHERE conversation_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(conversationId, limit) as Array<{
      id: number;
      conversationId: string;
      role: "user" | "assistant";
      content: string;
      qqMessageId: string | null;
      createdAt: string;
    }>;
    return rows
      .map((r) => ({
        id: r.id,
        conversationId: r.conversationId,
        role: r.role,
        content: r.content,
        qqMessageId: r.qqMessageId ?? undefined,
        createdAt: r.createdAt,
      }))
      .reverse();
  }

  listActiveMemories(conversationId: string, limit = 100): MemoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id AS conversationId, kind, content, source,
                active, created_at AS createdAt, updated_at AS updatedAt
         FROM memory_items
         WHERE conversation_id = ? AND active = 1
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(conversationId, limit) as Array<{
      id: number;
      conversationId: string;
      kind: MemoryKind;
      content: string;
      source: string;
      active: number;
      createdAt: string;
      updatedAt: string;
    }>;
    return rows.map((r) => ({
      ...r,
      active: !!r.active,
    }));
  }

  upsertMemory(input: {
    conversationId: string;
    kind: MemoryKind;
    content: string;
    source?: string;
  }): MemoryItem | null {
    this.ensureConversation(input.conversationId);
    const key = normalizeMemoryKey(input.content);
    if (!key) return null;
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT id FROM memory_items
         WHERE conversation_id = ? AND content_key = ? AND active = 1`,
      )
      .get(input.conversationId, key) as { id: number } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE memory_items SET updated_at = ?, kind = ? WHERE id = ?`,
        )
        .run(now, input.kind, existing.id);
      return this.getMemory(existing.id);
    }
    const result = this.db
      .prepare(
        `INSERT INTO memory_items
          (conversation_id, kind, content, content_key, source, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.kind,
        input.content,
        key,
        input.source ?? "deterministic",
        now,
        now,
      );
    const id = Number(result.lastInsertRowid);
    this.db
      .prepare(
        `INSERT INTO memory_fts (content, conversation_id, item_id) VALUES (?, ?, ?)`,
      )
      .run(input.content, input.conversationId, id);
    return this.getMemory(id);
  }

  getMemory(id: number): MemoryItem | null {
    const r = this.db
      .prepare(
        `SELECT id, conversation_id AS conversationId, kind, content, source,
                active, created_at AS createdAt, updated_at AS updatedAt
         FROM memory_items WHERE id = ?`,
      )
      .get(id) as
      | {
          id: number;
          conversationId: string;
          kind: MemoryKind;
          content: string;
          source: string;
          active: number;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;
    if (!r) return null;
    return { ...r, active: !!r.active };
  }

  /** Soft-delete (deactivate) a memory item. */
  deactivateMemory(id: number, conversationId?: string): boolean {
    const now = new Date().toISOString();
    const result = conversationId
      ? this.db
          .prepare(
            `UPDATE memory_items SET active = 0, updated_at = ?
             WHERE id = ? AND conversation_id = ?`,
          )
          .run(now, id, conversationId)
      : this.db
          .prepare(`UPDATE memory_items SET active = 0, updated_at = ? WHERE id = ?`)
          .run(now, id);
    if (Number(result.changes) > 0) {
      this.db.prepare(`DELETE FROM memory_fts WHERE item_id = ?`).run(id);
      return true;
    }
    return false;
  }

  /** Replace content of an active memory (correction). */
  correctMemory(
    id: number,
    conversationId: string,
    newContent: string,
  ): MemoryItem | null {
    const item = this.getMemory(id);
    if (!item || item.conversationId !== conversationId || !item.active) return null;
    const now = new Date().toISOString();
    const key = normalizeMemoryKey(newContent);
    this.db
      .prepare(
        `UPDATE memory_items
         SET content = ?, content_key = ?, kind = 'correction', updated_at = ?
         WHERE id = ?`,
      )
      .run(newContent, key, now, id);
    this.db.prepare(`DELETE FROM memory_fts WHERE item_id = ?`).run(id);
    this.db
      .prepare(
        `INSERT INTO memory_fts (content, conversation_id, item_id) VALUES (?, ?, ?)`,
      )
      .run(newContent, conversationId, id);
    return this.getMemory(id);
  }

  clearMemories(conversationId: string): number {
    const ids = (
      this.db
        .prepare(
          `SELECT id FROM memory_items WHERE conversation_id = ? AND active = 1`,
        )
        .all(conversationId) as Array<{ id: number }>
    ).map((r) => r.id);
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE memory_items SET active = 0, updated_at = ? WHERE conversation_id = ? AND active = 1`,
      )
      .run(now, conversationId);
    for (const id of ids) {
      this.db.prepare(`DELETE FROM memory_fts WHERE item_id = ?`).run(id);
    }
    return Number(result.changes);
  }

  searchMemories(conversationId: string, query: string, limit: number): MemoryItem[] {
    const q = sanitizeFtsQuery(query);
    if (!q) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT m.id, m.conversation_id AS conversationId, m.kind, m.content, m.source,
                  m.active, m.created_at AS createdAt, m.updated_at AS updatedAt
           FROM memory_fts
           JOIN memory_items m ON m.id = memory_fts.item_id
           WHERE memory_fts MATCH ?
             AND memory_fts.conversation_id = ?
             AND m.active = 1
           LIMIT ?`,
        )
        .all(q, conversationId, limit) as Array<{
        id: number;
        conversationId: string;
        kind: MemoryKind;
        content: string;
        source: string;
        active: number;
        createdAt: string;
        updatedAt: string;
      }>;
      return rows.map((r) => ({ ...r, active: !!r.active }));
    } catch {
      return [];
    }
  }

  searchTurns(
    conversationId: string,
    query: string,
    limit: number,
  ): Array<{ id: number; role: string; content: string }> {
    const q = sanitizeFtsQuery(query);
    if (!q) return [];
    try {
      return this.db
        .prepare(
          `SELECT turn_id AS id, role, content
           FROM turns_fts
           WHERE turns_fts MATCH ? AND conversation_id = ?
           LIMIT ?`,
        )
        .all(q, conversationId, limit) as Array<{
        id: number;
        role: string;
        content: string;
      }>;
    } catch {
      return [];
    }
  }

  getMaintenanceCheckpoint(conversationId: string): number {
    const row = this.db
      .prepare(
        `SELECT last_processed_turn_id AS id FROM maintenance_state WHERE conversation_id = ?`,
      )
      .get(conversationId) as { id: number } | undefined;
    return row?.id ?? 0;
  }

  setMaintenanceCheckpoint(conversationId: string, turnId: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO maintenance_state (conversation_id, last_processed_turn_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           last_processed_turn_id = excluded.last_processed_turn_id,
           updated_at = excluded.updated_at`,
      )
      .run(conversationId, turnId, now);
  }

  turnsAfter(conversationId: string, afterId: number, limit: number): StoredTurn[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id AS conversationId, role, content,
                qq_message_id AS qqMessageId, created_at AS createdAt
         FROM turns
         WHERE conversation_id = ? AND id > ? AND role = 'user'
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(conversationId, afterId, limit) as Array<{
      id: number;
      conversationId: string;
      role: "user" | "assistant";
      content: string;
      qqMessageId: string | null;
      createdAt: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      role: r.role,
      content: r.content,
      qqMessageId: r.qqMessageId ?? undefined,
      createdAt: r.createdAt,
    }));
  }

  listConversationIds(): string[] {
    return (
      this.db.prepare(`SELECT id FROM conversations ORDER BY updated_at DESC`).all() as Array<{
        id: string;
      }>
    ).map((r) => r.id);
  }

  getSessionMetrics(conversationId: string): {
    estimatedTokens: number;
    turnCount: number;
    memoryHash?: string;
    claudeSessionId?: string;
  } {
    const row = this.db
      .prepare(
        `SELECT estimated_tokens AS estimatedTokens, turn_count AS turnCount,
                memory_hash AS memoryHash, claude_session_id AS claudeSessionId
         FROM session_metrics WHERE conversation_id = ?`,
      )
      .get(conversationId) as
      | {
          estimatedTokens: number;
          turnCount: number;
          memoryHash: string | null;
          claudeSessionId: string | null;
        }
      | undefined;
    return {
      estimatedTokens: row?.estimatedTokens ?? 0,
      turnCount: row?.turnCount ?? 0,
      memoryHash: row?.memoryHash ?? undefined,
      claudeSessionId: row?.claudeSessionId ?? undefined,
    };
  }

  setSessionMetrics(
    conversationId: string,
    patch: {
      estimatedTokens?: number;
      turnCount?: number;
      memoryHash?: string;
      claudeSessionId?: string | null;
    },
  ): void {
    this.ensureConversation(conversationId);
    const cur = this.getSessionMetrics(conversationId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO session_metrics
          (conversation_id, claude_session_id, estimated_tokens, turn_count, memory_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           claude_session_id = excluded.claude_session_id,
           estimated_tokens = excluded.estimated_tokens,
           turn_count = excluded.turn_count,
           memory_hash = excluded.memory_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        conversationId,
        patch.claudeSessionId === null
          ? null
          : (patch.claudeSessionId ?? cur.claudeSessionId ?? null),
        patch.estimatedTokens ?? cur.estimatedTokens,
        patch.turnCount ?? cur.turnCount,
        patch.memoryHash ?? cur.memoryHash ?? null,
        now,
      );
  }
}

/** Build a safe FTS5 query from free text (keyword OR). */
export function sanitizeFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (!tokens.length) return "";
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}
