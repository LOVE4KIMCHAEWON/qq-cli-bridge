import fs from "node:fs";
import { ensureDataDirs, logPath } from "../paths.js";

function stamp(): string {
  return new Date().toISOString();
}

function write(level: string, message: string, meta?: unknown): void {
  ensureDataDirs();
  const line =
    meta === undefined
      ? `[${stamp()}] ${level} ${message}`
      : `[${stamp()}] ${level} ${message} ${safeJson(meta)}`;
  fs.appendFileSync(logPath(), line + "\n", "utf8");
  if (level === "ERROR") console.error(message);
}

function safeJson(meta: unknown): string {
  try {
    return JSON.stringify(meta, (_k, v) => {
      if (typeof v === "string" && /secret|token|password|appSecret/i.test(_k)) return "[redacted]";
      return v;
    });
  } catch {
    return "[unserializable]";
  }
}

export const log = {
  info: (message: string, meta?: unknown) => write("INFO", message, meta),
  warn: (message: string, meta?: unknown) => write("WARN", message, meta),
  error: (message: string, meta?: unknown) => write("ERROR", message, meta),
  debug: (message: string, meta?: unknown) => {
    if (process.env.QQBRIDGE_DEBUG) write("DEBUG", message, meta);
  },
};
