import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import readline from "node:readline";
import { isPidAlive, terminatePid } from "../lifecycle/process-info.js";
import { ownedChildren } from "../lifecycle/child-registry.js";
import { resolveSpawnPlan, spawnWithPlan } from "../util/process.js";
import { log } from "../util/logger.js";
import {
  assertClaudeChatOnlyArgsSafe,
  claudeChatOnlyArgs,
  sanitizeExtraArgs,
  scrubAgentEnv,
} from "../security/chat-only.js";

export interface ClaudeStreamSpawned {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  pid?: number;
  killed: boolean;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface ClaudeStreamClientOptions {
  command: string;
  extraArgs?: string[];
  cwd: string;
  /** Prefer dontAsk so QQ turns never hang on interactive tool prompts. */
  permissionMode?: string;
  promptTimeoutMs?: number;
  /** Test seam */
  spawnProcess?: () => ClaudeStreamSpawned | Promise<ClaudeStreamSpawned>;
}

export interface ClaudeStreamPromptHandlers {
  onPartialText?: (text: string) => void;
  onFirstText?: () => void;
}

export interface ClaudeStreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  thoughtTokens?: number;
}

export interface ClaudeStreamTurnResult {
  text: string;
  sessionId?: string;
  usage?: ClaudeStreamUsage;
  metrics: {
    promptSentAt: number;
    firstTextAt?: number;
    finalAt?: number;
  };
}

type PendingTurn = {
  resolve: (v: ClaudeStreamTurnResult) => void;
  reject: (e: Error) => void;
  handlers?: ClaudeStreamPromptHandlers;
  assistantParts: string[];
  resultText?: string;
  sessionId?: string;
  usage?: ClaudeStreamUsage;
  promptSentAt: number;
  firstTextAt?: number;
  timer: NodeJS.Timeout;
};

/**
 * Persistent Claude Code process via official stream-json I/O.
 *
 * Launch: `claude -p --verbose --input-format stream-json --output-format stream-json`
 * One OS process serves many prompts (stdin kept open). Verified on Claude Code 2.1.323.
 */
export class ClaudeStreamClient {
  private child?: ClaudeStreamSpawned;
  private stdoutRl?: readline.Interface;
  private stderrRl?: readline.Interface;
  private ready = false;
  private stopping = false;
  private crashing = false;
  lastTurnCompletionUnknown = false;
  private sessionId?: string;
  private queue: Array<{
    message: string;
    modelId?: string;
    handlers?: ClaudeStreamPromptHandlers;
    resolve: (v: ClaudeStreamTurnResult) => void;
    reject: (e: Error) => void;
  }> = [];
  private active?: PendingTurn;
  private readonly promptTimeoutMs: number;
  private initStartedAt = 0;
  private initCompletedAt = 0;
  /** Recent stderr lines for internal diagnostics (never sent to QQ). */
  private recentStderr: string[] = [];
  private lastExitCode: number | null | undefined;
  private lastExitSignal: NodeJS.Signals | null | undefined;
  /** Last spawn argv (test / diagnostics; never sent to QQ). */
  lastStartArgs: string[] = [];

  constructor(private readonly options: ClaudeStreamClientOptions) {
    this.promptTimeoutMs = options.promptTimeoutMs ?? 10 * 60_000;
  }

  get isReady(): boolean {
    return this.ready && !!this.child && !this.stopping && !this.crashing;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  get initDurationMs(): number | undefined {
    if (!this.initCompletedAt || !this.initStartedAt) return undefined;
    return this.initCompletedAt - this.initStartedAt;
  }

  clearCrashLatch(): void {
    this.crashing = false;
    this.lastTurnCompletionUnknown = false;
  }

  async start(
    opts: {
      resume?: string;
      modelId?: string;
      /** Absolute path for Claude --system-prompt-file (Persona). Applied at process start only. */
      systemPromptFile?: string;
      /**
       * When true with resume: fork a new session id so a changed system prompt
       * can apply without dropping prior turns (Claude snapshot otherwise ignores new prompts).
       */
      forkSession?: boolean;
    } = {},
  ): Promise<{ initMs: number }> {
    if (this.isReady) return { initMs: this.initDurationMs ?? 0 };
    await this.stop();
    this.stopping = false;
    this.crashing = false;
    this.lastTurnCompletionUnknown = false;
    this.initStartedAt = Date.now();

    // Chat-only: --tools "" disables all tools; --restricted + empty MCP.
    // permissionMode from options is ignored when it would weaken chat-only.
    void this.options.permissionMode;
    const chatArgs = claudeChatOnlyArgs();
    assertClaudeChatOnlyArgsSafe(chatArgs);
    const args = [
      ...sanitizeExtraArgs(this.options.extraArgs ?? []),
      "-p",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      ...chatArgs,
    ];
    if (opts.systemPromptFile) {
      args.push("--system-prompt-file", opts.systemPromptFile);
    }
    if (opts.resume) {
      args.push("--resume", opts.resume);
      this.sessionId = opts.resume;
      if (opts.forkSession) {
        args.push("--fork-session");
      }
    }
    if (opts.modelId) args.push("--model", opts.modelId);

    this.lastStartArgs = [...args];
    this.recentStderr = [];
    this.lastExitCode = undefined;
    this.lastExitSignal = undefined;

    const child = this.options.spawnProcess
      ? await this.options.spawnProcess()
      : await (async () => {
          const plan = await resolveSpawnPlan(this.options.command, args);
          log.info("claude-stream:spawn", {
            strategy: plan.strategy,
            cwd: this.options.cwd,
            argPreview: args
              .map((a) => (a.length > 48 ? `${a.slice(0, 48)}…` : a))
              .join(" "),
          });
          const proc = spawnWithPlan(plan, {
            cwd: this.options.cwd,
            env: scrubAgentEnv(),
            stdio: ["pipe", "pipe", "pipe"],
          }) as ChildProcess;
          ownedChildren.track(proc);
          return proc as unknown as ClaudeStreamSpawned;
        })();
    this.child = child;

    if (!child.stdin || !child.stdout) {
      throw new Error("Claude stream process missing stdio pipes");
    }

    this.stdoutRl = readline.createInterface({ input: child.stdout });
    this.stdoutRl.on("line", (line) => this.onStdoutLine(line));

    if (child.stderr) {
      this.stderrRl = readline.createInterface({ input: child.stderr });
      this.stderrRl.on("line", (line) => {
        this.recentStderr.push(line.slice(0, 240));
        if (this.recentStderr.length > 20) this.recentStderr.shift();
        log.warn("claude-stream:stderr", { line: line.slice(0, 200) });
      });
    }

    child.on("exit", (code, signal) => {
      this.lastExitCode = code as number | null;
      this.lastExitSignal = signal as NodeJS.Signals | null;
      log.warn("claude-stream:process_exit", {
        code,
        signal,
        stderrPreview: this.recentStderr.slice(-5).join(" | ").slice(0, 400),
        hadActiveTurn: !!this.active,
        stopping: this.stopping,
      });
      this.ready = false;
      // Unexpected exit (not our stop()) is always a crash — including before first prompt.
      if (!this.stopping) {
        this.crashing = true;
        if (this.active) {
          this.lastTurnCompletionUnknown = true;
          this.failActive(
            new Error(this.userSafeExitMessage(code as number | null, true)),
          );
        }
        this.rejectQueued(
          new Error(this.userSafeExitMessage(code as number | null, false)),
        );
      }
    });

    // Brief settle: catch immediate CLI arg/config failures before first prompt.
    await new Promise((r) => setTimeout(r, 80));
    if (this.crashing || this.lastExitCode != null || !this.child) {
      this.ready = false;
      throw new Error(this.userSafeExitMessage(this.lastExitCode ?? 1, false));
    }

    this.initCompletedAt = Date.now();
    this.ready = true;
    const initMs = this.initCompletedAt - this.initStartedAt;
    log.info("claude-stream:started", {
      initMs,
      resume: !!opts.resume,
      pid: child.pid,
    });
    return { initMs };
  }

  /** QQ-safe message — no raw stderr / MCP schema dumps. */
  private userSafeExitMessage(
    code: number | null,
    midTurn: boolean,
  ): string {
    const stderrBlob = this.recentStderr.join("\n");
    if (/Invalid MCP configuration/i.test(stderrBlob)) {
      return "Claude stream failed to start (invalid MCP configuration). Chat-only settings need a fix; try again after the bridge is updated.";
    }
    if (/unknown option|unrecognized|invalid.*flag/i.test(stderrBlob)) {
      return "Claude stream failed to start (unsupported CLI flags for this Claude version).";
    }
    if (midTurn) {
      return "Claude stream stopped unexpectedly during this turn. Send a new message to recover (the previous turn is not replayed).";
    }
    if (code != null && code !== 0) {
      return "Claude stream process failed to stay running. Send a new message to recover.";
    }
    return "Claude stream process exited. Send a new message to recover.";
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.rejectQueued(new Error("Claude stream client stopped"));
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.reject(new Error("Claude stream client stopped"));
      this.active = undefined;
    }
    this.stdoutRl?.close();
    this.stdoutRl = undefined;
    this.stderrRl?.close();
    this.stderrRl = undefined;
    const child = this.child;
    this.child = undefined;
    const pid = child?.pid;
    if (child && !child.killed) {
      try {
        child.stdin?.end();
      } catch {
        // ignore
      }
      try {
        child.kill();
      } catch {
        // ignore
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1500);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (pid && isPidAlive(pid)) {
      terminatePid(pid, true);
      await new Promise((r) => setTimeout(r, 300));
    }
    if (pid && isPidAlive(pid)) {
      log.error("claude-stream:orphan_process", { pid });
    }
  }

  /** Enqueue a user turn on the live process (reuses OS process). */
  prompt(
    message: string,
    opts: { modelId?: string; handlers?: ClaudeStreamPromptHandlers } = {},
  ): Promise<ClaudeStreamTurnResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        message,
        modelId: opts.modelId,
        handlers: opts.handlers,
        resolve,
        reject,
      });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.active || this.queue.length === 0) return;
    if (!this.isReady || !this.child?.stdin) {
      const next = this.queue.shift();
      next?.reject(new Error("Claude stream process not ready"));
      return;
    }
    const job = this.queue.shift()!;
    const promptSentAt = Date.now();
    const timer = setTimeout(() => {
      this.failActive(new Error("Claude stream turn timed out"));
    }, this.promptTimeoutMs);

    this.active = {
      resolve: job.resolve,
      reject: job.reject,
      handlers: job.handlers,
      assistantParts: [],
      promptSentAt,
      timer,
    };

    // Model changes mid-session: Claude stream-json supports control set_model via SDK;
    // for CLI we restart with --model when needed (handled by adapter).
    const payload = {
      type: "user",
      message: { role: "user", content: job.message },
      parent_tool_use_id: null,
    };
    try {
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    } catch (err) {
      this.failActive(err as Error);
    }
  }

  private onStdoutLine(line: string): void {
    const t = line.trim();
    if (!t.startsWith("{")) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      log.debug("claude-stream:parse_error", { preview: t.slice(0, 80) });
      return;
    }
    const type = typeof obj.type === "string" ? obj.type : "";

    if (typeof obj.session_id === "string") {
      this.sessionId = obj.session_id;
      if (this.active) this.active.sessionId = obj.session_id;
    }

    if (type === "system" && obj.subtype === "init") {
      if (typeof obj.session_id === "string") this.sessionId = obj.session_id;
      return;
    }

    if (type === "stream_event") {
      const event = obj.event as Record<string, unknown> | undefined;
      const delta = event?.delta as Record<string, unknown> | undefined;
      const text =
        (typeof delta?.text === "string" && delta.text) ||
        (typeof (event as { text?: string } | undefined)?.text === "string"
          ? (event as { text: string }).text
          : "");
      if (text && this.active) {
        if (!this.active.firstTextAt) {
          this.active.firstTextAt = Date.now();
          this.active.handlers?.onFirstText?.();
        }
        this.active.handlers?.onPartialText?.(text);
      }
      return;
    }

    if (type === "assistant") {
      const text = extractAssistantText(obj);
      if (text && this.active) {
        this.active.assistantParts.push(text);
        if (!this.active.firstTextAt) {
          this.active.firstTextAt = Date.now();
          this.active.handlers?.onFirstText?.();
        }
      }
      return;
    }

    if (type === "result") {
      if (!this.active) return;
      const resultField =
        typeof obj.result === "string"
          ? obj.result
          : typeof obj.result === "object" && obj.result
            ? extractContentText(obj.result)
            : undefined;
      if (resultField) this.active.resultText = resultField;
      this.active.usage = parseClaudeUsage(obj.usage ?? obj);
      if (typeof obj.session_id === "string") {
        this.sessionId = obj.session_id;
        this.active.sessionId = obj.session_id;
      }
      this.finishActive();
    }
  }

  private finishActive(): void {
    const cur = this.active;
    if (!cur) return;
    clearTimeout(cur.timer);
    this.active = undefined;
    const joined = cur.assistantParts.join("").trim();
    const text = (cur.resultText || joined || "").trim();
    cur.resolve({
      text,
      sessionId: cur.sessionId ?? this.sessionId,
      usage: cur.usage,
      metrics: {
        promptSentAt: cur.promptSentAt,
        firstTextAt: cur.firstTextAt,
        finalAt: Date.now(),
      },
    });
    void this.pump();
  }

  private failActive(err: Error): void {
    const cur = this.active;
    if (!cur) return;
    clearTimeout(cur.timer);
    this.active = undefined;
    cur.reject(err);
  }

  private rejectQueued(err: Error): void {
    for (const q of this.queue) q.reject(err);
    this.queue = [];
  }
}

function extractAssistantText(obj: Record<string, unknown>): string | undefined {
  const message = obj.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (message && typeof message === "object") {
    return extractContentText(message);
  }
  return undefined;
}

function extractContentText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;
  if (typeof m.content === "string" && m.content.trim()) return m.content.trim();
  if (Array.isArray(m.content)) {
    const parts: string[] = [];
    for (const block of m.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string" && b.text.trim()) parts.push(b.text);
    }
    if (parts.length) return parts.join("");
  }
  return undefined;
}

function parseClaudeUsage(raw: unknown): ClaudeStreamUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const usage: ClaudeStreamUsage = {
    inputTokens: num(u.input_tokens) ?? num(u.inputTokens),
    outputTokens: num(u.output_tokens) ?? num(u.outputTokens),
    cacheReadTokens:
      num(u.cache_read_input_tokens) ?? num(u.cacheReadTokens),
    cacheWriteTokens:
      num(u.cache_creation_input_tokens) ?? num(u.cacheWriteTokens),
    thoughtTokens:
      num((u.output_tokens_details as Record<string, unknown> | undefined)?.thinking_tokens) ??
      num(u.thoughtTokens),
  };
  if (
    usage.inputTokens == null &&
    usage.outputTokens == null &&
    usage.cacheReadTokens == null
  ) {
    return undefined;
  }
  return usage;
}
