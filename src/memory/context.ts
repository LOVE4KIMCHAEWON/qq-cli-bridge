import crypto from "node:crypto";
import type { MemoryConfig, MemoryItem, SessionContextBundle, StoredTurn } from "./types.js";
import { estimateTokens } from "./tokens.js";
import type { MemoryStore } from "./store.js";

function hashSection(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function formatMemoryLines(items: MemoryItem[], maxItems: number): string[] {
  return items.slice(0, maxItems).map((m) => `- [${m.kind}] ${m.content}`);
}

function formatRecent(turns: StoredTurn[]): string[] {
  return turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`);
}

/**
 * Build a compact long-term memory + recent window + optional retrieval section
 * for injection once at Claude session start (not every turn).
 */
export function buildSessionContext(
  store: MemoryStore,
  conversationId: string,
  config: MemoryConfig,
  opts: { queryHints?: string; includeCarryOverNote?: boolean } = {},
): SessionContextBundle {
  const budget = config.contextBudgetTokens;
  const memories = store.listActiveMemories(conversationId, config.maxMemoryItems);
  const recent = store.recentTurns(conversationId, config.recentWindowTurns * 2);

  let retrieval: Array<{ id: number; role?: string; content: string }> = [];
  if (opts.queryHints?.trim()) {
    const memHits = store.searchMemories(
      conversationId,
      opts.queryHints,
      config.maxRetrievalSnippets,
    );
    const turnHits = store.searchTurns(
      conversationId,
      opts.queryHints,
      config.maxRetrievalSnippets,
    );
    const seen = new Set<string>();
    for (const m of memHits) {
      const k = `m:${m.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      retrieval.push({ id: m.id, content: m.content });
    }
    for (const t of turnHits) {
      const k = `t:${t.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      retrieval.push({ id: t.id, role: t.role, content: t.content });
    }
    retrieval = retrieval.slice(0, config.maxRetrievalSnippets);
  }

  const parts: string[] = ["--- Long-term Memory ---"];
  if (memories.length === 0) {
    parts.push("(none yet)");
  } else {
    parts.push(...formatMemoryLines(memories, config.maxMemoryItems));
  }

  if (retrieval.length) {
    parts.push("", "--- Retrieved notes ---");
    for (const r of retrieval) {
      const label = r.role ? `${r.role}: ` : "";
      parts.push(`- ${label}${r.content}`);
    }
  }

  parts.push("", "--- Recent conversation ---");
  if (!recent.length) {
    parts.push("(new conversation)");
  } else {
    parts.push(...formatRecent(recent));
  }

  if (opts.includeCarryOverNote) {
    parts.push(
      "",
      "--- Carry-over ---",
      "Prior Claude session was rotated for context limits. Continue naturally using Memory and Recent conversation above.",
    );
  }

  // Trim from the middle of recent window if over budget (keep memory first).
  let text = parts.join("\n") + "\n";
  let tokens = estimateTokens(text);
  if (tokens > budget && recent.length > 2) {
    let trimmedRecent = [...recent];
    while (trimmedRecent.length > 2 && tokens > budget) {
      trimmedRecent = trimmedRecent.slice(2); // drop oldest pair-ish
      const rebuild = [
        "--- Long-term Memory ---",
        ...(memories.length
          ? formatMemoryLines(memories, config.maxMemoryItems)
          : ["(none yet)"]),
      ];
      if (retrieval.length) {
        rebuild.push("", "--- Retrieved notes ---");
        for (const r of retrieval) {
          rebuild.push(`- ${r.role ? `${r.role}: ` : ""}${r.content}`);
        }
      }
      rebuild.push("", "--- Recent conversation ---", ...formatRecent(trimmedRecent));
      if (opts.includeCarryOverNote) {
        rebuild.push(
          "",
          "--- Carry-over ---",
          "Prior Claude session was rotated for context limits. Continue naturally using Memory and Recent conversation above.",
        );
      }
      text = rebuild.join("\n") + "\n";
      tokens = estimateTokens(text);
    }
  }

  // Last resort: drop retrieval then shrink memory lines.
  if (tokens > budget) {
    const memLines = formatMemoryLines(memories, config.maxMemoryItems);
    while (memLines.length > 5 && estimateTokens(memLines.join("\n")) > budget * 0.5) {
      memLines.pop();
    }
    const rebuild = [
      "--- Long-term Memory ---",
      ...(memLines.length ? memLines : ["(none yet)"]),
      "",
      "--- Recent conversation ---",
      ...formatRecent(recent.slice(-4)),
    ];
    if (opts.includeCarryOverNote) {
      rebuild.push(
        "",
        "--- Carry-over ---",
        "Prior Claude session was rotated for context limits. Continue naturally using Memory and Recent conversation above.",
      );
    }
    text = rebuild.join("\n") + "\n";
    tokens = estimateTokens(text);
  }

  return {
    memorySection: text,
    memoryHash: hashSection(text),
    estimatedTokens: tokens,
    recentTurnCount: recent.length,
    retrievalCount: retrieval.length,
    activeMemoryCount: memories.length,
  };
}

export function memoryProfileHash(store: MemoryStore, conversationId: string): string {
  const items = store.listActiveMemories(conversationId, 200);
  const raw = items.map((m) => `${m.id}:${m.kind}:${m.content}`).join("|");
  return hashSection(raw || "empty");
}
