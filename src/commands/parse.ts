import { normalizeInboundQqText } from "../qq/mentions.js";

export interface ParsedSlashCommand {
  name: string;
  args: string[];
  raw: string;
}

/**
 * Parse a QQ message as a slash command.
 * Only leading `/command` forms qualify — not mid-message mentions.
 * Leading QQ `@bot` markers (`<@openid>`) are stripped first so group
 * `@bot /model` matches the same router as C2C `/model`.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | undefined {
  const trimmed = normalizeInboundQqText(text);
  if (!trimmed.startsWith("/")) return undefined;
  // Do not treat //comments or URLs as commands
  if (trimmed.startsWith("//") || trimmed.startsWith("/http")) return undefined;

  const body = trimmed.slice(1).trim();
  if (!body) return undefined;

  const parts = body.split(/\s+/);
  const name = (parts[0] ?? "").toLowerCase();
  if (!name || !/^[a-z][a-z0-9_-]*$/.test(name)) return undefined;
  return {
    name,
    args: parts.slice(1),
    raw: trimmed,
  };
}
