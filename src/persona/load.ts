import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataRoot, ensureDataDirs } from "../paths.js";
import { log } from "../util/logger.js";
import {
  DEFAULT_PERSONA_TEXT,
  PERSONA_SYSTEM_FRAMING,
  personaFramingForProfile,
  type PersonaCapabilityProfile,
} from "./default.js";
export type { PersonaCapabilityProfile } from "./default.js";

/** Soft cap so a huge persona.md cannot blow token budgets. */
export const PERSONA_MAX_CHARS = 12_000;

export type PersonaSource =
  | "file"
  | "default-created"
  | "fallback-empty"
  | "fallback-missing"
  | "fallback-error"
  | "fallback-truncated";

export interface LoadedPersona {
  /** Persona body used in the composed system prompt (never sent as a user message). */
  text: string;
  /** SHA-256 of the normalized persona body (for change detection). */
  hash: string;
  /** Absolute path of the user-editable persona file. */
  path: string;
  source: PersonaSource;
  /** Absolute path of the composed Claude --system-prompt-file. */
  systemPromptFile: string;
}

/** Override for tests: QQBRIDGE_PERSONA_PATH */
export function personaPath(): string {
  const env = process.env.QQBRIDGE_PERSONA_PATH;
  if (env?.trim()) return path.resolve(env.trim());
  return path.join(dataRoot(), "persona.md");
}

export function composedSystemPromptPath(): string {
  return path.join(dataRoot(), "state", "claude-qq-system-prompt.txt");
}

export function hashPersonaText(text: string): string {
  return crypto.createHash("sha256").update(normalizePersonaText(text), "utf8").digest("hex");
}

export function normalizePersonaText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
}

/**
 * Ensure data/persona.md exists with the default text (UTF-8).
 * Safe to call repeatedly; does not overwrite a non-empty existing file.
 */
export function ensurePersonaFile(): string {
  ensureDataDirs();
  const p = personaPath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, DEFAULT_PERSONA_TEXT, "utf8");
    log.info("persona:created_default", { path: p });
    return p;
  }
  try {
    const existing = fs.readFileSync(p, "utf8");
    if (!normalizePersonaText(existing)) {
      fs.writeFileSync(p, DEFAULT_PERSONA_TEXT, "utf8");
      log.info("persona:replaced_empty", { path: p });
    }
  } catch {
    // leave as-is; loadPersona will fall back
  }
  return p;
}

/**
 * Build the Persona section of the system prompt.
 * Capability framing is backend-specific (Claude: no tools; Codex: hosted search OK).
 */
export function buildPersonaSystemSection(
  personaBody: string,
  capabilityProfile: PersonaCapabilityProfile = "claude-chat",
): string {
  const framing = personaFramingForProfile(capabilityProfile);
  return `${framing}\n--- Persona ---\n${personaBody}\n`;
}

/**
 * Compose the Claude --system-prompt-file body.
 * Persona first; optional Memory then Culture — never merge those stores.
 * Prefer `composeBridgeSystemPrompt` / `assembleBridgeContext` from context/assemble
 * for backend-neutral callers; this remains a Claude-oriented alias (claude-chat profile).
 * Called at session start/rotation only — not every QQ turn.
 */
export function composeClaudeSystemPrompt(parts: {
  personaBody: string;
  memorySection?: string;
  cultureSection?: string;
  capabilityProfile?: PersonaCapabilityProfile;
}): string {
  // Lazy import avoided: keep persona free of culture/memory modules.
  // Assembly lives in context/assemble; duplicated join logic kept trivial here.
  const sections = [
    buildPersonaSystemSection(parts.personaBody, parts.capabilityProfile ?? "claude-chat"),
  ];
  if (parts.memorySection?.trim()) {
    sections.push(parts.memorySection.trimEnd() + "\n");
  }
  if (parts.cultureSection?.trim()) {
    sections.push(parts.cultureSection.trimEnd() + "\n");
  }
  return sections.join("\n");
}

function writeComposedSystemPrompt(personaBody: string): string {
  ensureDataDirs();
  const out = composedSystemPromptPath();
  // Default file is Persona-only; MemoryManager overwrites with Persona+Memory at session start.
  fs.writeFileSync(out, composeClaudeSystemPrompt({ personaBody }), "utf8");
  return out;
}

/**
 * Load the editable Persona and write the composed Claude system-prompt file.
 * Missing / empty / unreadable config falls back to DEFAULT_PERSONA_TEXT.
 */
export function loadPersona(): LoadedPersona {
  const p = personaPath();
  let text = DEFAULT_PERSONA_TEXT;
  let source: PersonaSource = "fallback-missing";

  try {
    if (!fs.existsSync(p)) {
      ensurePersonaFile();
      text = DEFAULT_PERSONA_TEXT;
      source = "default-created";
    } else {
      const raw = fs.readFileSync(p, "utf8");
      const normalized = normalizePersonaText(raw);
      if (!normalized) {
        text = DEFAULT_PERSONA_TEXT;
        source = "fallback-empty";
        log.warn("persona:empty_fallback", { path: p });
      } else if (normalized.length > PERSONA_MAX_CHARS) {
        text = normalized.slice(0, PERSONA_MAX_CHARS);
        source = "fallback-truncated";
        log.warn("persona:truncated", { path: p, maxChars: PERSONA_MAX_CHARS });
      } else {
        text = normalized;
        source = "file";
      }
    }
  } catch (err) {
    text = DEFAULT_PERSONA_TEXT;
    source = "fallback-error";
    log.warn("persona:read_error_fallback", {
      path: p,
      error: (err as Error).message,
    });
  }

  const systemPromptFile = writeComposedSystemPrompt(text);
  return {
    text,
    hash: hashPersonaText(text),
    path: p,
    source,
    systemPromptFile,
  };
}

/** Claude argv flags that inject Persona once at session start (not per user message). */
export function claudePersonaSystemArgs(persona: LoadedPersona): string[] {
  return ["--system-prompt-file", persona.systemPromptFile];
}

/** Brief status for operators / slash help — never includes persona body. */
export function personaStatusLine(persona: LoadedPersona): string {
  return `Persona loaded (${persona.source}, hash ${persona.hash.slice(0, 8)}…). Edit ${persona.path}; next stream restart applies changes with --resume/--fork-session (history kept).`;
}
