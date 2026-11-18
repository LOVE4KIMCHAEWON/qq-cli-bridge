import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { cultureDbPath, ensureDataDirs } from "../paths.js";
import { log } from "../util/logger.js";
import { matchTemplate } from "./patterns.js";
import { SEED_PATTERNS, SEED_TERMS } from "./seed.js";
import type {
  CultureConfidence,
  CulturePattern,
  CultureScope,
  CultureSourceKind,
  CultureTerm,
} from "./types.js";

export type CultureStoreOptions = {
  dbPath?: string;
  /** Skip curated seed (tests that want empty DB). */
  skipSeed?: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

function parseAliases(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Separate SQLite Culture KB (not Memory, not Persona).
 * Global + conversation-scoped terms/patterns with confidence + provenance.
 */
export class CultureStore {
  readonly dbPath: string;
  private db: DatabaseSync;
  private closed = false;

  constructor(opts: CultureStoreOptions = {}) {
    if (opts.dbPath === ":memory:") {
      this.dbPath = ":memory:";
      this.db = new DatabaseSync(":memory:");
    } else {
      ensureDataDirs();
      this.dbPath = opts.dbPath ?? cultureDbPath();
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      this.db = new DatabaseSync(this.dbPath);
      try {
        fs.chmodSync(this.dbPath, 0o600);
      } catch {
        // Windows may ignore chmod.
      }
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    if (!opts.skipSeed) {
      this.seedIfEmpty();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS culture_terms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL,
        term_key TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        gloss TEXT NOT NULL,
        community TEXT,
        confidence TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('global','conversation')),
        conversation_id TEXT,
        source TEXT NOT NULL,
        source_note TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_culture_terms_key
        ON culture_terms(term_key, active);

      CREATE INDEX IF NOT EXISTS idx_culture_terms_conv
        ON culture_terms(conversation_id, active);

      CREATE TABLE IF NOT EXISTS culture_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        template TEXT NOT NULL,
        gloss TEXT NOT NULL,
        example TEXT,
        community TEXT,
        confidence TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('global','conversation')),
        conversation_id TEXT,
        source TEXT NOT NULL,
        source_note TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_culture_patterns_active
        ON culture_patterns(active);

      CREATE TABLE IF NOT EXISTS culture_session (
        conversation_id TEXT PRIMARY KEY,
        culture_hash TEXT,
        last_query TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private seedIfEmpty(): void {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM culture_terms`).get() as {
      n: number;
    };
    if (row.n > 0) return;
    const seeded = this.db.prepare(`SELECT value FROM meta WHERE key = 'seeded'`).get() as
      | { value: string }
      | undefined;
    if (seeded?.value === "1") return;

    const insertTerm = this.db.prepare(
      `INSERT INTO culture_terms
        (term, term_key, aliases_json, gloss, community, confidence, scope,
         conversation_id, source, source_note, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'global', NULL, ?, ?, 1, ?, ?)`,
    );
    const insertPat = this.db.prepare(
      `INSERT INTO culture_patterns
        (name, template, gloss, example, community, confidence, scope,
         conversation_id, source, source_note, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'global', NULL, ?, ?, 1, ?, ?)`,
    );
    const ts = nowIso();
    this.db.exec("BEGIN");
    try {
      for (const t of SEED_TERMS) {
        insertTerm.run(
          t.term,
          normalizeKey(t.term),
          JSON.stringify(t.aliases ?? []),
          t.gloss,
          t.community ?? null,
          t.confidence ?? "confirmed",
          t.source ?? "seed:curated",
          t.sourceNote ?? null,
          ts,
          ts,
        );
      }
      for (const p of SEED_PATTERNS) {
        insertPat.run(
          p.name,
          p.template,
          p.gloss,
          p.example ?? null,
          p.community ?? null,
          p.confidence ?? "plausible",
          p.source ?? "seed:curated",
          p.sourceNote ?? null,
          ts,
          ts,
        );
      }
      this.db
        .prepare(
          `INSERT INTO meta (key, value) VALUES ('seeded', '1')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run();
      this.db.exec("COMMIT");
      log.info("culture:seeded", {
        terms: SEED_TERMS.length,
        patterns: SEED_PATTERNS.length,
      });
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private mapTerm(r: Record<string, unknown>): CultureTerm {
    return {
      id: Number(r.id),
      term: String(r.term),
      aliases: parseAliases(r.aliases_json as string),
      gloss: String(r.gloss),
      community: r.community ? String(r.community) : undefined,
      confidence: r.confidence as CultureConfidence,
      scope: r.scope as CultureScope,
      conversationId: r.conversation_id ? String(r.conversation_id) : undefined,
      source: r.source as CultureSourceKind,
      sourceNote: r.source_note ? String(r.source_note) : undefined,
      active: !!r.active,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  private mapPattern(r: Record<string, unknown>): CulturePattern {
    return {
      id: Number(r.id),
      name: String(r.name),
      template: String(r.template),
      gloss: String(r.gloss),
      example: r.example ? String(r.example) : undefined,
      community: r.community ? String(r.community) : undefined,
      confidence: r.confidence as CultureConfidence,
      scope: r.scope as CultureScope,
      conversationId: r.conversation_id ? String(r.conversation_id) : undefined,
      source: r.source as CultureSourceKind,
      sourceNote: r.source_note ? String(r.source_note) : undefined,
      active: !!r.active,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  upsertTerm(input: {
    term: string;
    gloss: string;
    aliases?: string[];
    community?: string;
    confidence: CultureConfidence;
    scope: CultureScope;
    conversationId?: string;
    source: CultureSourceKind;
    sourceNote?: string;
  }): CultureTerm {
    const term = input.term.trim();
    const termKey = normalizeKey(term);
    const ts = nowIso();
    const conv = input.scope === "conversation" ? input.conversationId ?? null : null;

    // Deactivate prior active row with same key+scope visibility.
    if (input.scope === "global") {
      this.db
        .prepare(
          `UPDATE culture_terms SET active = 0, updated_at = ?
           WHERE term_key = ? AND scope = 'global' AND active = 1`,
        )
        .run(ts, termKey);
    } else {
      this.db
        .prepare(
          `UPDATE culture_terms SET active = 0, updated_at = ?
           WHERE term_key = ? AND scope = 'conversation'
             AND conversation_id = ? AND active = 1`,
        )
        .run(ts, termKey, conv);
    }

    const info = this.db
      .prepare(
        `INSERT INTO culture_terms
          (term, term_key, aliases_json, gloss, community, confidence, scope,
           conversation_id, source, source_note, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        term,
        termKey,
        JSON.stringify(input.aliases ?? []),
        input.gloss.trim(),
        input.community ?? null,
        input.confidence,
        input.scope,
        conv,
        input.source,
        input.sourceNote ?? null,
        ts,
        ts,
      );

    const id = Number(info.lastInsertRowid);
    const row = this.db
      .prepare(`SELECT * FROM culture_terms WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    return this.mapTerm(row);
  }

  listActiveTerms(conversationId?: string, limit = 200): CultureTerm[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM culture_terms
         WHERE active = 1
           AND (scope = 'global'
                OR (scope = 'conversation' AND conversation_id = ?))
         ORDER BY
           CASE confidence
             WHEN 'confirmed' THEN 0
             WHEN 'community_local' THEN 1
             WHEN 'plausible' THEN 2
             ELSE 3
           END,
           id DESC
         LIMIT ?`,
      )
      .all(conversationId ?? "", limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTerm(r));
  }

  listActivePatterns(conversationId?: string, limit = 50): CulturePattern[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM culture_patterns
         WHERE active = 1
           AND (scope = 'global'
                OR (scope = 'conversation' AND conversation_id = ?))
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(conversationId ?? "", limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapPattern(r));
  }

  findTermExact(term: string, conversationId?: string): CultureTerm | null {
    const key = normalizeKey(term);
    // Conversation-scoped wins over global when both exist.
    if (conversationId) {
      const local = this.db
        .prepare(
          `SELECT * FROM culture_terms
           WHERE active = 1 AND term_key = ? AND scope = 'conversation'
             AND conversation_id = ?
           LIMIT 1`,
        )
        .get(key, conversationId) as Record<string, unknown> | undefined;
      if (local) return this.mapTerm(local);
    }
    const global = this.db
      .prepare(
        `SELECT * FROM culture_terms
         WHERE active = 1 AND term_key = ? AND scope = 'global'
         LIMIT 1`,
      )
      .get(key) as Record<string, unknown> | undefined;
    return global ? this.mapTerm(global) : null;
  }

  /**
   * Retrieve terms visible in a conversation that appear in `query`
   * (exact / alias / substring for CJK).
   */
  searchTermsInText(conversationId: string, query: string, limit: number): CultureTerm[] {
    if (!query.trim()) return [];
    const terms = this.listActiveTerms(conversationId, 500);
    const q = query.toLowerCase();
    const hits: Array<{ term: CultureTerm; score: number }> = [];
    for (const t of terms) {
      const candidates = [t.term, ...t.aliases];
      let score = 0;
      for (const c of candidates) {
        if (!c) continue;
        const cl = c.toLowerCase();
        if (q.includes(cl)) {
          score = Math.max(score, 100 + c.length);
        } else if (cl.length >= 2 && q.includes(cl.slice(0, Math.min(cl.length, 4)))) {
          // weak partial — skip; require full token presence
        }
      }
      if (score > 0) hits.push({ term: t, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit).map((h) => h.term);
  }

  matchPatternsInText(
    conversationId: string,
    query: string,
    limit: number,
  ): Array<{ pattern: CulturePattern; matched: string; slots: string[] }> {
    if (!query.trim()) return [];
    const patterns = this.listActivePatterns(conversationId);
    const out: Array<{ pattern: CulturePattern; matched: string; slots: string[] }> = [];
    for (const p of patterns) {
      const matches = matchTemplate(p.template, query);
      for (const m of matches) {
        out.push({ pattern: p, matched: m.matched, slots: m.slots });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  setSessionCultureHash(conversationId: string, cultureHash: string, lastQuery?: string): void {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO culture_session (conversation_id, culture_hash, last_query, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           culture_hash = excluded.culture_hash,
           last_query = COALESCE(excluded.last_query, culture_session.last_query),
           updated_at = excluded.updated_at`,
      )
      .run(conversationId, cultureHash, lastQuery ?? null, ts);
  }

  getSessionCultureHash(conversationId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT culture_hash FROM culture_session WHERE conversation_id = ?`)
      .get(conversationId) as { culture_hash: string | null } | undefined;
    return row?.culture_hash ?? undefined;
  }

  setLastQuery(conversationId: string, query: string): void {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO culture_session (conversation_id, culture_hash, last_query, updated_at)
         VALUES (?, NULL, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           last_query = excluded.last_query,
           updated_at = excluded.updated_at`,
      )
      .run(conversationId, query.slice(0, 500), ts);
  }

  getLastQuery(conversationId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT last_query FROM culture_session WHERE conversation_id = ?`)
      .get(conversationId) as { last_query: string | null } | undefined;
    return row?.last_query ?? undefined;
  }

  /** Stable hash of active culture visible to a conversation (for inject-once / fork). */
  profileHash(conversationId: string): string {
    const terms = this.listActiveTerms(conversationId, 300);
    const patterns = this.listActivePatterns(conversationId, 50);
    const payload = JSON.stringify({
      terms: terms.map((t) => [t.id, t.term, t.gloss, t.confidence, t.scope]),
      patterns: patterns.map((p) => [p.id, p.template, p.gloss]),
    });
    return crypto.createHash("sha256").update(payload).digest("hex");
  }

  termCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM culture_terms WHERE active = 1`).get() as {
      n: number;
    };
    return row.n;
  }
}
