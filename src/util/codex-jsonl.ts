import { log } from "./logger.js";

/**
 * Codex CLI v0.169 `exec --json` event stream (newline-delimited JSON).
 *
 * Observed shapes:
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,...}}
 */

export interface CodexUsageTokens {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface CodexExecParseResult {
  /** Joined agent_message texts for QQ (never raw JSON). */
  text?: string;
  threadId?: string;
  usage?: CodexUsageTokens;
  assistantMessageCount: number;
  /** True when stdout looked like Codex JSONL but had no agent_message. */
  hadJsonlEvents: boolean;
  parseErrors: number;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function extractAgentMessageText(item: Record<string, unknown>): string | undefined {
  if (item.type !== "agent_message") return undefined;
  if (typeof item.text === "string" && item.text.trim()) return item.text.trim();
  // Some variants nest content blocks
  if (Array.isArray(item.content)) {
    const parts: string[] = [];
    for (const block of item.content) {
      const b = asRecord(block);
      if (!b) continue;
      if (typeof b.text === "string" && b.text.trim()) parts.push(b.text.trim());
      else if (b.type === "output_text" && typeof b.text === "string" && b.text.trim()) {
        parts.push(b.text.trim());
      }
    }
    if (parts.length) return parts.join("\n");
  }
  return undefined;
}

function parseUsage(raw: unknown): CodexUsageTokens | undefined {
  const u = asRecord(raw);
  if (!u) return undefined;
  const usage: CodexUsageTokens = {
    inputTokens: num(u.input_tokens) ?? num(u.inputTokens),
    cachedInputTokens: num(u.cached_input_tokens) ?? num(u.cachedInputTokens),
    cacheWriteInputTokens:
      num(u.cache_write_input_tokens) ?? num(u.cacheWriteInputTokens),
    outputTokens: num(u.output_tokens) ?? num(u.outputTokens),
    reasoningOutputTokens:
      num(u.reasoning_output_tokens) ?? num(u.reasoningOutputTokens),
  };
  if (
    usage.inputTokens == null &&
    usage.outputTokens == null &&
    usage.cachedInputTokens == null &&
    usage.reasoningOutputTokens == null
  ) {
    return undefined;
  }
  return usage;
}

/**
 * Parse Codex `exec --json` stdout into QQ-safe assistant text + optional usage.
 * Never returns raw JSON lines.
 */
export function parseCodexExecJsonl(stdout: string): CodexExecParseResult {
  const messages: string[] = [];
  let threadId: string | undefined;
  let usage: CodexUsageTokens | undefined;
  let hadJsonlEvents = false;
  let parseErrors = 0;

  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      parseErrors++;
      log.debug("codex:jsonl_parse_error", { preview: t.slice(0, 80) });
      continue;
    }
    if (typeof obj.type !== "string") continue;
    hadJsonlEvents = true;

    if (obj.type === "thread.started") {
      if (typeof obj.thread_id === "string") threadId = obj.thread_id;
      else if (typeof obj.threadId === "string") threadId = obj.threadId;
      continue;
    }

    // Only completed agent_message items are user-visible to QQ.
    // Ignore item.started / item.updated / reasoning / tool payloads.
    if (obj.type === "item.completed") {
      const item = asRecord(obj.item);
      if (!item) continue;
      const text = extractAgentMessageText(item);
      if (text) messages.push(text);
      continue;
    }

    if (obj.type === "turn.completed") {
      const u = parseUsage(obj.usage);
      if (u) usage = u;
      continue;
    }

    // Intentionally ignore: turn.started, item.started, tool/reasoning items, errors
    // logged only when useful for diagnostics.
    if (obj.type === "error" || obj.type === "turn.failed") {
      log.warn("codex:jsonl_error_event", {
        type: obj.type,
        message:
          typeof obj.message === "string"
            ? obj.message.slice(0, 160)
            : undefined,
      });
    }
  }

  return {
    text: messages.length ? messages.join("\n\n") : undefined,
    threadId,
    usage,
    assistantMessageCount: messages.length,
    hadJsonlEvents,
    parseErrors,
  };
}

/** True if stdout looks like Codex exec --json event stream. */
export function looksLikeCodexJsonl(stdout: string): boolean {
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t) as { type?: string };
      if (
        typeof obj.type === "string" &&
        /^(thread\.|turn\.|item\.)/.test(obj.type)
      ) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}
