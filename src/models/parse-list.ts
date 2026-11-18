import type { ModelInfo } from "./types.js";

/**
 * Parse Cursor Agent `agent --list-models` / `agent models` text output:
 *   id - Display Name (current, default)
 */
export function parseAgentModelList(text: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("Available") || t.startsWith("Tip:")) continue;
    const m = t.match(/^(\S+)\s+-\s+(.+)$/);
    if (!m) continue;
    const id = m[1]!;
    let displayName = m[2]!.trim();
    const current = /\(current\b/i.test(displayName);
    const isDefault = /\bdefault\)/i.test(displayName);
    displayName = displayName
      .replace(/\s*\((?:current(?:,\s*default)?|default(?:,\s*current)?)\)\s*$/i, "")
      .trim();
    models.push({ id, displayName, current, isDefault });
  }
  return models;
}

/** Parse Gemini `models list -o json` / `--list-models -o json` arrays. */
export function parseGeminiModelJson(text: string): ModelInfo[] {
  const trimmed = text.trim();
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    // Maybe stdout has leading noise — find first [ or {
    const startArr = trimmed.indexOf("[");
    const startObj = trimmed.indexOf("{");
    const start =
      startArr >= 0 && (startObj < 0 || startArr < startObj) ? startArr : startObj;
    if (start < 0) return [];
    try {
      data = JSON.parse(trimmed.slice(start));
    } catch {
      return [];
    }
  }

  const rows: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { models?: unknown }).models)
      ? ((data as { models: unknown[] }).models)
      : [];

  const models: ModelInfo[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const id =
      (typeof o.modelId === "string" && o.modelId) ||
      (typeof o.id === "string" && o.id) ||
      (typeof o.name === "string" && o.name) ||
      undefined;
    if (!id) continue;
    const displayName =
      (typeof o.displayName === "string" && o.displayName) ||
      (typeof o.name === "string" && o.name) ||
      id;
    models.push({ id, displayName });
  }
  return models;
}

/** Parse Codex `codex debug models` JSON catalog. */
export function parseCodexModelJson(text: string): ModelInfo[] {
  const trimmed = text.trim();
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    if (start < 0) return [];
    try {
      data = JSON.parse(trimmed.slice(start));
    } catch {
      return [];
    }
  }
  if (!data || typeof data !== "object") return [];
  const modelsRaw = (data as { models?: unknown }).models;
  if (!Array.isArray(modelsRaw)) return [];

  const models: ModelInfo[] = [];
  for (const row of modelsRaw) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    // Prefer list-visible entries when visibility is present
    if (typeof o.visibility === "string" && o.visibility !== "list") continue;
    const id =
      (typeof o.slug === "string" && o.slug) ||
      (typeof o.id === "string" && o.id) ||
      (typeof o.name === "string" && o.name) ||
      undefined;
    if (!id) continue;
    const displayName =
      (typeof o.display_name === "string" && o.display_name) ||
      (typeof o.displayName === "string" && o.displayName) ||
      (typeof o.name === "string" && o.name) ||
      id;
    models.push({ id, displayName });
  }
  return models;
}

/** Inject `--model <id>` into argv without duplicating an existing --model/-m. */
export function injectModelArg(
  args: string[],
  modelId: string | undefined,
  flag: "--model" | "-m" = "--model",
): string[] {
  if (!modelId) return args;
  const out = [...args];
  // Remove prior --model/-m pairs
  for (let i = 0; i < out.length; ) {
    if (out[i] === "--model" || out[i] === "-m") {
      out.splice(i, 2);
      continue;
    }
    i++;
  }
  // Place model flag near the front (after subcommands like exec/resume handled by caller)
  out.unshift(flag, modelId);
  return out;
}
