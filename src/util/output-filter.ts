import stripAnsi from "strip-ansi";

const SENSITIVE =
  /(api[_-]?key|app[_-]?secret|authorization:|bearer\s+[a-z0-9\-._~+/]+=*|password\s*[:=])/i;

const NOISE_LINE =
  /^(thinking|reasoning|tool\s+call|running tool|spinner|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏)/i;

/** Phrases that indicate the model is dumping internal Persona / system framing. */
const PERSONA_LEAK =
  /(---\s*Persona\s*---|PERSONA_SYSTEM_FRAMING|system prompt or the Persona configuration|Chat-only mode|Hosted web search \(web_search|Capabilities:\s*text chat only)/i;

/**
 * Strip ANSI and drop sensitive / noisy terminal lines before QQ delivery.
 */
export function sanitizeForQq(text: string, maxChars = 3500): string {
  let clean = stripAnsi(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (PERSONA_LEAK.test(clean)) {
    // Refuse to forward obvious Persona / system-prompt dumps.
    return "（内容已过滤：请换个话题继续聊。）";
  }
  const lines = clean.split("\n").filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (SENSITIVE.test(t)) return false;
    if (NOISE_LINE.test(t)) return false;
    return true;
  });
  clean = lines.join("\n").trim();
  if (clean.length > maxChars) {
    clean = clean.slice(0, maxChars - 20) + "\n…[truncated]";
  }
  return clean;
}

export function extractJsonFinalText(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  // Whole-document JSON
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const text = pickText(obj);
    if (text) return text;
  } catch {
    // continue
  }

  // NDJSON / stream-json: last message with result/text
  const lines = trimmed.split("\n");
  let last: string | undefined;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      const text = pickText(obj);
      if (text) last = text;
    } catch {
      // ignore broken line
    }
  }
  return last;
}

function pickText(obj: Record<string, unknown>): string | undefined {
  for (const key of ["result", "response", "text", "message", "content", "last_agent_message"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  if (typeof obj.type === "string" && obj.type === "result" && typeof obj.result === "string") {
    return obj.result;
  }
  // Claude stream-json style
  if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
    const msg = obj.message as { content?: Array<{ type?: string; text?: string }> };
    const parts = msg.content?.filter((c) => c.type === "text" && c.text).map((c) => c.text!) ?? [];
    if (parts.length) return parts.join("\n");
  }
  return undefined;
}
