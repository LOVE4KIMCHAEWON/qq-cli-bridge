import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ownedChildren } from "../lifecycle/child-registry.js";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Resolved spawn plan — never concatenates argv into an unquoted shell string. */
export interface SpawnPlan {
  file: string;
  args: string[];
  options: SpawnOptions;
  /** Human-readable description for logs/tests. */
  strategy: "direct" | "cmd-batch" | "powershell-file" | "shell-fallback";
}

function windowsComSpec(): string {
  return (
    process.env.ComSpec ||
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe")
  );
}

function windowsPowerShell(): string {
  return path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

/**
 * Quote one argv token for cmd.exe when using `/d /s /c` + windowsVerbatimArguments.
 *
 * cmd.exe still treats `& | < > ( ) ! % ^` specially even inside quotes, so those
 * are caret-escaped (or `%` → `%%`). Tokens with whitespace/quotes/metas are wrapped.
 */
export function quoteForCmdExe(arg: string): string {
  if (arg.length === 0) return '""';
  const needsQuotes = /[\s"&^|<>()!%]/.test(arg);
  let body = arg.replace(/"/g, '""');
  body = body
    .replace(/\^/g, "^^")
    .replace(/%/g, "%%")
    .replace(/&/g, "^&")
    .replace(/\|/g, "^|")
    .replace(/</g, "^<")
    .replace(/>/g, "^>")
    .replace(/\(/g, "^(")
    .replace(/\)/g, "^)")
    .replace(/!/g, "^!");
  return needsQuotes ? `"${body}"` : body;
}

async function whereAll(command: string): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const out = await new Promise<string>((resolve) => {
    const child = spawn("where.exe", [command], { windowsHide: true });
    let buf = "";
    child.stdout.on("data", (b: Buffer) => {
      buf += b.toString("utf8");
    });
    child.on("close", () => resolve(buf));
    child.on("error", () => resolve(""));
  });
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && fs.existsSync(l));
}

function rankWindowsCandidate(file: string): number {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".exe") return 0;
  if (ext === ".cmd" || ext === ".bat") return 1;
  if (ext === ".ps1") return 2;
  return 3;
}

/**
 * Build a Windows-safe spawn plan.
 *
 * Root cause of EINVAL: Node cannot CreateProcess a `.cmd`/`.bat` with shell:false.
 * Fix: route batch files through cmd.exe with argv array + windowsVerbatimArguments;
 * route `.ps1` through powershell.exe -File with separate argv (no string concat of user args).
 */
export function buildSpawnPlan(command: string, args: string[], candidates?: string[]): SpawnPlan {
  const baseOptions: SpawnOptions = { windowsHide: true, shell: false };

  if (process.platform !== "win32") {
    return { file: command, args, options: baseOptions, strategy: "direct" };
  }

  let target = command;
  if (candidates && candidates.length) {
    const sorted = [...candidates].sort(
      (a, b) => rankWindowsCandidate(a) - rankWindowsCandidate(b),
    );
    target = sorted[0]!;
  } else if (!path.isAbsolute(command) && !command.includes("/") && !command.includes("\\")) {
    // Caller should pass candidates from whereAll; fall through with bare name.
    target = command;
  }

  const ext = path.extname(target).toLowerCase();

  if (ext === ".exe" || ext === ".com") {
    return { file: target, args, options: baseOptions, strategy: "direct" };
  }

  if (ext === ".cmd" || ext === ".bat") {
    // Match cross-spawn / Node shell:false batch launching:
    // cmd.exe /d /s /c "<quoted-file> <quoted-args…>"
    // Outer quotes are required so cmd metacharacters inside tokens (e.g. &) parse correctly.
    const cmdline = [quoteForCmdExe(target), ...args.map(quoteForCmdExe)].join(" ");
    return {
      file: windowsComSpec(),
      args: ["/d", "/s", "/c", `"${cmdline}"`],
      options: { ...baseOptions, windowsVerbatimArguments: true },
      strategy: "cmd-batch",
    };
  }

  if (ext === ".ps1") {
    return {
      file: windowsPowerShell(),
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", target, ...args],
      options: baseOptions,
      strategy: "powershell-file",
    };
  }

  // Bare command name with no resolved path: try cmd /c with quoted tokens (still argv-based).
  if (!path.isAbsolute(target) && !target.includes("\\")) {
    const cmdline = [quoteForCmdExe(target), ...args.map(quoteForCmdExe)].join(" ");
    return {
      file: windowsComSpec(),
      args: ["/d", "/s", "/c", `"${cmdline}"`],
      options: { ...baseOptions, windowsVerbatimArguments: true },
      strategy: "cmd-batch",
    };
  }

  return { file: target, args, options: baseOptions, strategy: "direct" };
}

/** Cache resolved executable path (not full argv plans) when safe. */
const resolvedCommandCache = new Map<string, { file: string; at: number }>();
const RESOLVE_CACHE_MS = 60_000;

export function clearSpawnResolveCache(): void {
  resolvedCommandCache.clear();
}

export async function resolveSpawnPlan(command: string, args: string[]): Promise<SpawnPlan> {
  if (process.platform === "win32") {
    const absolute =
      path.isAbsolute(command) || command.includes("/") || command.includes("\\");
    if (absolute) return buildSpawnPlan(command, args, [command]);

    const cached = resolvedCommandCache.get(command);
    const now = Date.now();
    if (cached && now - cached.at < RESOLVE_CACHE_MS && fs.existsSync(cached.file)) {
      return buildSpawnPlan(command, args, [cached.file]);
    }

    const candidates = await whereAll(command);
    if (candidates.length) {
      const sorted = [...candidates].sort(
        (a, b) => rankWindowsCandidate(a) - rankWindowsCandidate(b),
      );
      resolvedCommandCache.set(command, { file: sorted[0]!, at: now });
    }
    return buildSpawnPlan(command, args, candidates.length ? candidates : undefined);
  }
  return buildSpawnPlan(command, args);
}

export function spawnWithPlan(
  plan: SpawnPlan,
  extra: SpawnOptions = {},
): ChildProcess {
  const child = spawn(plan.file, plan.args, {
    ...plan.options,
    ...extra,
    env: { ...process.env, ...((extra.env as NodeJS.ProcessEnv) || undefined) },
    shell: false,
  });
  ownedChildren.track(child);
  return child;
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
  } = {},
): Promise<RunResult> {
  const plan = await resolveSpawnPlan(command, args);

  return new Promise((resolve, reject) => {
    const child = spawnWithPlan(plan, {
      cwd: options.cwd,
      env: options.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer =
      options.timeoutMs &&
      setTimeout(() => {
        child.kill();
        if (!settled) {
          settled = true;
          reject(new Error(`Command timed out: ${command}`));
        }
      }, options.timeoutMs);

    child.stdout?.on("data", (buf: Buffer) => {
      stdout += buf.toString("utf8");
    });
    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString("utf8");
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code, stdout, stderr });
      }
    });

    if (options.input != null) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const hits = await whereAll(command);
      return hits.length > 0;
    }
    const result = await runCommand("which", [command], { timeoutMs: 10_000 });
    return (result.code ?? 1) === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Interactive attach helper used by adapters (stdio inherit). */
export async function spawnInteractive(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const plan = await resolveSpawnPlan(command, args);
  return await new Promise<number>((resolve, reject) => {
    const child = spawnWithPlan(plan, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      windowsHide: false,
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}

export function tryLoadNodePty():
  | {
      spawn: (
        file: string,
        args: string[],
        options: Record<string, unknown>,
      ) => {
        write: (data: string) => void;
        onData: (cb: (data: string) => void) => void;
        onExit: (cb: (e: { exitCode: number }) => void) => void;
        kill: () => void;
      };
    }
  | undefined {
  try {
    const require = createRequire(import.meta.url);
    return require("node-pty") as ReturnType<typeof tryLoadNodePty>;
  } catch {
    return undefined;
  }
}

export function platformInfo(): { platform: NodeJS.Platform; tmp: string } {
  return { platform: process.platform, tmp: os.tmpdir() };
}
