import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Project root (the directory containing package.json). */
export function projectRoot(): string {
  // dist/ -> project root; src/ during tsx
  const candidate = path.resolve(__dirname, "..");
  if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  return path.resolve(__dirname, "../..");
}

/** Runtime data dir: QQBRIDGE_DATA_DIR, else <project>/data. Never a random temp path. */
export function dataRoot(): string {
  const env = process.env.QQBRIDGE_DATA_DIR;
  if (env) return path.resolve(env);
  const preferred = path.join(projectRoot(), "data");
  return preferred;
}

export function ensureDataDirs(): void {
  const root = dataRoot();
  for (const sub of [
    "",
    "secrets",
    "state",
    "logs",
    "sessions",
    "chat-runtime",
    "memory",
    "culture",
    "codex-qq-home",
  ]) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
}

/** Isolated Codex home for QQ-restricted mode (no user plugins/MCP). */
export function codexQqHomePath(): string {
  return path.join(dataRoot(), "codex-qq-home");
}

/** Long-term memory + chat archive SQLite DB (separate from secrets / persona). */
export function memoryDbPath(): string {
  return path.join(dataRoot(), "memory", "memory.sqlite");
}

/** Culture KB SQLite (slang / community norms; separate from Memory + Persona). */
export function cultureDbPath(): string {
  return path.join(dataRoot(), "culture", "culture.sqlite");
}

export function configPath(): string {
  return path.join(dataRoot(), "config.json");
}

export function secretsPath(): string {
  return path.join(dataRoot(), "secrets", "qq.enc.json");
}

export function statePath(): string {
  return path.join(dataRoot(), "state", "runtime.json");
}

export function lockPath(): string {
  return path.join(dataRoot(), "state", "turn.lock");
}

export function logPath(): string {
  return path.join(dataRoot(), "logs", "qqbridge.log");
}

export function homeFallback(): string {
  return path.join(os.homedir(), ".qq-cli-bridge");
}
