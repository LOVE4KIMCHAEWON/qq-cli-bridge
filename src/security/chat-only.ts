import fs from "node:fs";
import path from "node:path";
import { dataRoot, ensureDataDirs, projectRoot } from "../paths.js";
import { log } from "../util/logger.js";
import type { AgentKind } from "../types.js";
import { ensurePersonaFile } from "../persona/load.js";

/**
 * Mandatory Chat-only security for the QQ bot.
 * Goal: message in → AI text out. Not a remote coding agent.
 */
export const CHAT_ONLY_POLICY_VERSION = 1;

/**
 * Backends allowed for QQ Chat-only.
 * - Claude: official `--tools ""` + restricted + empty MCP.
 * - Codex: only via Bridge-enforced restricted App Server mode
 *   (isolated CODEX_HOME, disabled local tools, hosted web_search, deny approvals).
 *
 * Cursor / Gemini remain disabled (no verified restricted chat profile).
 */
export const QQ_CHAT_ALLOWED_BACKENDS: readonly AgentKind[] = ["claude", "codex"];

export function isQqChatBackendAllowed(kind: AgentKind): boolean {
  return (QQ_CHAT_ALLOWED_BACKENDS as readonly string[]).includes(kind);
}

export function qqChatBackendBlockReason(kind: AgentKind): string {
  switch (kind) {
    case "claude":
      return "";
    case "codex":
      return "";
    case "agent":
      return (
        "Cursor Agent has no official no-tools mode for QQ. " +
        "`ask`/`plan` still load tools (read-only). Disabled until a verified tool-free API exists. Use: qqbridge claude --transport stream --no-terminal"
      );
    case "gemini":
      return (
        "Gemini `--approval-mode plan` is read-only, not tool-free. Disabled for QQ until a verified no-tools mode exists. Use: qqbridge claude --transport stream --no-terminal"
      );
    case "custom":
      return "Custom CLIs are not allowed under Chat-only QQ (cannot verify tool disablement).";
    default:
      return `Backend "${kind}" is not allowed for Chat-only QQ.`;
  }
}

/** Dangerous CLI flag fragments that must never reach agent spawns. */
const DANGEROUS_ARG_PATTERNS = [
  /^-f$/,
  /^--force$/,
  /^--yolo$/,
  /dangerously/i,
  /bypass.*permission/i,
  /bypass.*sandbox/i,
  /skip-permissions/i,
  /^--approve-mcps$/i,
  /^--add-dir$/i,
  /^--mcp-config$/i,
];

/** Env vars required for CLI auth; everything else is stripped from agent children. */
const AUTH_ENV_ALLOWLIST = new Set([
  // Process basics
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "USERDOMAIN",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "LANG",
  "LC_ALL",
  "TERM",
  // Node (for .cmd launchers)
  "NODE_OPTIONS",
  // Anthropic / Claude
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // OpenAI / Codex
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_HOME",
  // Google / Gemini
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_APPLICATION_CREDENTIALS",
  // Cursor
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
]);

export function chatRuntimeRoot(): string {
  return path.join(dataRoot(), "chat-runtime");
}

/**
 * Dedicated empty-ish working directory for AI CLIs.
 * Never the bridge project root, never the user's home, never secrets/.
 */
export function ensureChatRuntimeDir(): string {
  ensureDataDirs();
  const root = chatRuntimeRoot();
  fs.mkdirSync(root, { recursive: true });
  // Marker so operators and tests can identify the sandbox.
  const marker = path.join(root, ".qqbridge-chat-only");
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(
      marker,
      JSON.stringify(
        {
          v: CHAT_ONLY_POLICY_VERSION,
          purpose: "chat-only-runtime",
          note: "AI backends must only use this directory as cwd. No project or personal files.",
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  // Scratch subdir the model could see if tools leak — keep empty / disposable.
  fs.mkdirSync(path.join(root, "scratch"), { recursive: true });
  return root;
}

export function isChatRuntimePath(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  const runtime = path.resolve(chatRuntimeRoot());
  return (
    resolved === runtime ||
    resolved.startsWith(runtime + path.sep)
  );
}

export function assertSafeAgentCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  const proj = path.resolve(projectRoot());
  const secrets = path.resolve(path.join(dataRoot(), "secrets"));
  if (resolved === proj || resolved.startsWith(proj + path.sep)) {
    // Allow only the dedicated chat-runtime under data/
    if (!isChatRuntimePath(resolved)) {
      throw new Error(
        `Chat-only policy: agent cwd must not be the bridge project (${proj}). Use ${chatRuntimeRoot()}.`,
      );
    }
  }
  if (resolved === secrets || resolved.startsWith(secrets + path.sep)) {
    throw new Error("Chat-only policy: agent cwd must not be the secrets directory.");
  }
  return resolved;
}

/**
 * Build a minimal env for agent subprocesses.
 * Preserves CLI auth; strips unrelated secrets and QQ credentials.
 */
export function scrubAgentEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    QQBRIDGE_CHAT_ONLY: "1",
    QQBRIDGE_CHAT_ONLY_VERSION: String(CHAT_ONLY_POLICY_VERSION),
  };
  for (const [key, value] of Object.entries(base)) {
    if (value == null) continue;
    if (AUTH_ENV_ALLOWLIST.has(key)) {
      out[key] = value;
      continue;
    }
    // Allow uppercase keys that look like provider auth (narrow).
    if (
      /^(ANTHROPIC_|OPENAI_|CODEX_|GOOGLE_|GEMINI_|CURSOR_|CLAUDE_)/i.test(key) &&
      !/QQ|SECRET_KEY|APP_SECRET|PASSWORD|PRIVATE/i.test(key)
    ) {
      out[key] = value;
    }
  }
  // Never pass QQ bot credentials into the model process.
  delete out.QQ_APP_ID;
  delete out.QQ_APP_SECRET;
  delete out.QQBOT_APP_ID;
  delete out.QQBOT_APP_SECRET;
  return out;
}

/** Strip operator extraArgs that would re-enable agent capabilities. */
export function sanitizeExtraArgs(extraArgs: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i]!;
    const dangerous = DANGEROUS_ARG_PATTERNS.some((re) => re.test(arg));
    if (dangerous) {
      log.warn("chat-only:stripped_extra_arg", { arg });
      // Skip following value for flags that take an argument
      if (
        /^(--add-dir|--mcp-config|--allowedTools|--allowed-tools|--tools)$/i.test(
          arg,
        ) &&
        extraArgs[i + 1] &&
        !extraArgs[i + 1]!.startsWith("-")
      ) {
        i++;
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * Claude Code: disable all tools + restricted + no MCP.
 *
 * IMPORTANT: `--mcp-config` must be a JSON object with `mcpServers` (a record).
 * Passing `{}` makes Claude CLI exit immediately with:
 *   "Invalid MCP configuration: mcpServers: Invalid input: expected record"
 * That crash was observed as "Claude stream process exited mid-turn" on QQ.
 */
export function claudeChatOnlyArgs(): string[] {
  return [
    "--tools",
    "",
    "--restricted",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
  ];
}

/** Validate chat-only Claude argv shape (used by tests / startup checks). */
export function assertClaudeChatOnlyArgsSafe(args: string[]): void {
  const i = args.indexOf("--mcp-config");
  if (i < 0 || i + 1 >= args.length) {
    throw new Error("Claude chat-only args missing --mcp-config");
  }
  const raw = args[i + 1]!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Claude --mcp-config is not valid JSON: ${raw.slice(0, 80)}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("mcpServers" in (parsed as object)) ||
    typeof (parsed as { mcpServers?: unknown }).mcpServers !== "object" ||
    (parsed as { mcpServers: unknown }).mcpServers === null ||
    Array.isArray((parsed as { mcpServers: unknown }).mcpServers)
  ) {
    throw new Error(
      'Claude --mcp-config must be {"mcpServers":{...}} (empty object is OK)',
    );
  }
  if (!args.includes("--tools")) {
    throw new Error("Claude chat-only args missing --tools");
  }
}

/**
 * Codex exec oneshot flags (non-QQ / legacy). Prefer restricted App Server for QQ.
 * Note: approval_policy="untrusted" is rejected by Codex ≥0.169 config overrides;
 * use on-request + Bridge rejection instead.
 */
export function codexExecChatOnlyArgs(): string[] {
  return [
    "-s",
    "read-only",
    "-c",
    'approval_policy="on-request"',
    "-c",
    'sandbox_mode="read-only"',
  ];
}

/** Cursor Agent oneshot: no --force; plan mode + sandbox enabled. */
export function cursorOneshotChatOnlyArgs(): string[] {
  return ["--mode", "plan", "--sandbox", "enabled"];
}

/** Gemini oneshot: plan (read-only) approval mode; never yolo. */
export function geminiOneshotChatOnlyArgs(): string[] {
  return ["--approval-mode", "plan"];
}

export interface ChatOnlySessionMeta {
  chatOnlyVersion: number;
  cwd: string;
}

export function isPrivilegedSessionMeta(meta: {
  cwd?: string;
  chatOnlyVersion?: number;
} | undefined): boolean {
  if (!meta) return true; // unknown → treat as privileged / unsafe to resume
  if (meta.chatOnlyVersion !== CHAT_ONLY_POLICY_VERSION) return true;
  if (!meta.cwd || !isChatRuntimePath(meta.cwd)) return true;
  return false;
}

/**
 * Prepare Chat-only startup.
 * Does NOT delete credentials, config, or session files on disk.
 * Adapters refuse to resume privileged sessions (wrong cwd / missing chatOnlyVersion)
 * and start fresh chat sessions instead.
 */
export function prepareChatOnlyStartup(): {
  runtimeDir: string;
  note: string;
} {
  const runtimeDir = ensureChatRuntimeDir();
  try {
    ensurePersonaFile();
  } catch (err) {
    log.warn("persona:ensure_failed", { error: (err as Error).message });
  }
  log.info("chat-only:startup", {
    runtimeDir,
    policyVersion: CHAT_ONLY_POLICY_VERSION,
    allowedBackends: [...QQ_CHAT_ALLOWED_BACKENDS],
    note: "Privileged session files are left on disk but will not be resumed.",
  });
  return {
    runtimeDir,
    note: "Chat-only: privileged sessions are not resumed; session files are preserved on disk.",
  };
}

/** @deprecated Use prepareChatOnlyStartup — does not delete session data. */
export function migrateSessionsToChatOnly(): {
  clearedTransports: string[];
  clearedAcp: number;
} {
  prepareChatOnlyStartup();
  return { clearedTransports: [], clearedAcp: 0 };
}

export function chatOnlyStatusLine(backend: string): string {
  if (/codex/i.test(backend)) {
    return `Chat-only QQ bot (${backend}): local tools disabled; hosted web_search permitted; cwd=${chatRuntimeRoot()}`;
  }
  return `Chat-only QQ bot (${backend}): tools disabled via CLI; cwd=${chatRuntimeRoot()}`;
}
