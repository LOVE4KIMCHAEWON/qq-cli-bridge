import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import readline from "node:readline";
import { NdjsonJsonRpcClient, JsonRpcError } from "../acp/jsonrpc-client.js";
import { isPidAlive, terminatePid } from "../lifecycle/process-info.js";
import { ownedChildren } from "../lifecycle/child-registry.js";
import { resolveSpawnPlan, spawnWithPlan } from "../util/process.js";
import { log } from "../util/logger.js";
import { sanitizeExtraArgs } from "../security/chat-only.js";
import {
  codexRestrictedChildEnv,
  codexRestrictedCliFlags,
  ensureCodexQqHome,
} from "../security/codex-restricted.js";

export interface CodexAppServerSpawned {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  pid?: number;
  killed: boolean;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexAppServerClientOptions {
  command: string;
  extraArgs?: string[];
  cwd: string;
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandboxMode;
  /** Isolated CODEX_HOME for QQ-restricted mode. */
  codexHome?: string;
  /** When true (default for QQ), force restricted CLI flags + isolated home. */
  restricted?: boolean;
  /** Injected at thread/start (Persona + Memory + Culture). */
  developerInstructions?: string;
  promptTimeoutMs?: number;
  initTimeoutMs?: number;
  spawnProcess?: () => CodexAppServerSpawned | Promise<CodexAppServerSpawned>;
}

export interface CodexTurnHandlers {
  onPartialText?: (text: string) => void;
  onFirstText?: () => void;
  onPermission?: (summary: string) => void;
  /** Fired when a forbidden local tool item is observed; Bridge should fail closed. */
  onForbiddenTool?: (summary: string) => void;
}

export interface CodexAppServerUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface CodexTurnResult {
  text: string;
  threadId: string;
  turnId?: string;
  usage?: CodexAppServerUsage;
  /** True when a hosted web_search item completed this turn. */
  webSearchCompleted?: boolean;
  metrics: {
    promptSentAt: number;
    firstTextAt?: number;
    finalAt?: number;
  };
}

/**
 * Persistent Codex `app-server --stdio` JSON-RPC client.
 * One process; many threads/turns.
 */
export class CodexAppServerClient {
  private child?: CodexAppServerSpawned;
  private rpc?: NdjsonJsonRpcClient;
  private stderrRl?: readline.Interface;
  private ready = false;
  private stopping = false;
  private crashing = false;
  lastTurnCompletionUnknown = false;
  private initStartedAt = 0;
  private initCompletedAt = 0;
  private readonly promptTimeoutMs: number;
  private readonly initTimeoutMs: number;
  private readonly approvalPolicy: CodexApprovalPolicy;
  private readonly sandbox: CodexSandboxMode;
  private readonly restricted: boolean;
  private readonly codexHome: string;
  private developerInstructions?: string;

  private activeTurn?: {
    threadId: string;
    turnId?: string;
    resolve: (v: CodexTurnResult) => void;
    reject: (e: Error) => void;
    handlers?: CodexTurnHandlers;
    messages: string[];
    usage?: CodexAppServerUsage;
    webSearchCompleted: boolean;
    promptSentAt: number;
    firstTextAt?: number;
    timer: NodeJS.Timeout;
  };

  constructor(private readonly options: CodexAppServerClientOptions) {
    this.promptTimeoutMs = options.promptTimeoutMs ?? 10 * 60_000;
    this.initTimeoutMs = options.initTimeoutMs ?? 120_000;
    this.restricted = options.restricted !== false;
    // Chat-only / restricted: always require approval (bridge rejects) + read-only sandbox.
    // Never use approvalPolicy "never" (auto-approve). Prefer on-request (Codex 0.169+).
    this.approvalPolicy = "on-request";
    this.sandbox = "read-only";
    void options.approvalPolicy;
    void options.sandbox;
    this.codexHome =
      options.codexHome ??
      (this.restricted ? ensureCodexQqHome().homeDir : process.env.CODEX_HOME || "");
    this.developerInstructions = options.developerInstructions;
  }

  setDeveloperInstructions(text: string | undefined): void {
    this.developerInstructions = text;
  }

  get isReady(): boolean {
    return this.ready && !!this.rpc && !this.rpc.isClosed && !this.stopping;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get initDurationMs(): number | undefined {
    if (!this.initCompletedAt || !this.initStartedAt) return undefined;
    return this.initCompletedAt - this.initStartedAt;
  }

  clearCrashLatch(): void {
    this.crashing = false;
    this.lastTurnCompletionUnknown = false;
  }

  async start(): Promise<{ initMs: number }> {
    if (this.isReady) return { initMs: this.initDurationMs ?? 0 };
    await this.stop();
    this.stopping = false;
    this.crashing = false;
    this.lastTurnCompletionUnknown = false;
    this.initStartedAt = Date.now();

    const child = this.options.spawnProcess
      ? await this.options.spawnProcess()
      : await (async () => {
          const restrictedFlags = this.restricted
            ? codexRestrictedCliFlags({ webSearch: "live" })
            : [];
          const args = [
            ...sanitizeExtraArgs(this.options.extraArgs ?? []),
            ...restrictedFlags,
            "app-server",
            "--stdio",
          ];
          const plan = await resolveSpawnPlan(this.options.command, args);
          const env = this.restricted
            ? codexRestrictedChildEnv(this.codexHome)
            : codexRestrictedChildEnv(this.codexHome || process.env.CODEX_HOME || "");
          const proc = spawnWithPlan(plan, {
            cwd: this.options.cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
          }) as ChildProcess;
          ownedChildren.track(proc);
          return proc as unknown as CodexAppServerSpawned;
        })();
    this.child = child;

    if (!child.stdin || !child.stdout) {
      throw new Error("Codex app-server missing stdio pipes");
    }

    const rpc = new NdjsonJsonRpcClient(child.stdin, child.stdout, {
      defaultTimeoutMs: this.promptTimeoutMs,
    });
    this.rpc = rpc;

    rpc.on("notification", (method, params, raw) => {
      const msg = raw as { id?: string | number; method?: string; params?: unknown };
      // Server→client requests include an id; notifications do not.
      if (msg?.id != null && typeof method === "string") {
        this.handleServerRequest(String(method), params, msg.id);
        return;
      }
      this.handleNotification(String(method), params);
    });
    rpc.on("close", () => {
      this.ready = false;
      if (this.activeTurn) {
        this.lastTurnCompletionUnknown = true;
        this.crashing = true;
        this.failActive(new Error("Codex app-server closed mid-turn"));
      }
    });
    rpc.on("parse_error", (err, line) => {
      log.warn("codex-app-server:parse_error", {
        message: (err as Error).message,
        linePreview: String(line).slice(0, 80),
      });
    });

    if (child.stderr) {
      this.stderrRl = readline.createInterface({ input: child.stderr });
      this.stderrRl.on("line", (line) => {
        log.debug("codex-app-server:stderr", { line: line.slice(0, 200) });
      });
    }

    child.on("exit", (code, signal) => {
      log.warn("codex-app-server:process_exit", { code, signal });
      this.ready = false;
      this.rpc?.close("process_exit");
      if (this.activeTurn) {
        this.lastTurnCompletionUnknown = true;
        this.crashing = true;
        this.failActive(new Error("Codex app-server exited mid-turn"));
      }
    });

    await rpc.request(
      "initialize",
      {
        clientInfo: { name: "qq-cli-bridge", version: "0.1.0" },
        capabilities: null,
      },
      this.initTimeoutMs,
    );

    this.initCompletedAt = Date.now();
    this.ready = true;
    const initMs = this.initCompletedAt - this.initStartedAt;
    log.info("codex-app-server:initialized", { initMs, pid: child.pid });
    return { initMs };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    if (this.activeTurn) {
      clearTimeout(this.activeTurn.timer);
      this.activeTurn.reject(new Error("Codex app-server stopped"));
      this.activeTurn = undefined;
    }
    this.rpc?.close("stop");
    this.rpc = undefined;
    this.stderrRl?.close();
    this.stderrRl = undefined;
    const child = this.child;
    this.child = undefined;
    const pid = child?.pid;
    if (child && !child.killed) {
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
      log.error("codex-app-server:orphan_process", { pid });
    }
  }

  async threadStart(opts: {
    cwd?: string;
    model?: string;
    developerInstructions?: string;
  } = {}): Promise<{ threadId: string }> {
    const rpc = this.requireRpc();
    const developerInstructions =
      opts.developerInstructions ?? this.developerInstructions;
    const result = (await rpc.request("thread/start", {
      cwd: opts.cwd ?? this.options.cwd,
      model: opts.model,
      approvalPolicy: this.approvalPolicy,
      // Never auto-approve; bridge rejects all approval RPCs.
      approvalsReviewer: "user",
      sandbox: this.sandbox,
      // Explicit per-thread override — same as successful standalone probes.
      config: this.restricted ? { web_search: "live" } : undefined,
      ...(developerInstructions
        ? { developerInstructions }
        : {}),
    })) as { thread?: { id?: string }; threadId?: string };

    const threadId = result.thread?.id ?? result.threadId;
    if (!threadId) throw new Error("Codex thread/start returned no thread id");
    return { threadId };
  }

  async threadResume(
    threadId: string,
    opts: { cwd?: string; model?: string; developerInstructions?: string } = {},
  ): Promise<{ threadId: string }> {
    const rpc = this.requireRpc();
    const developerInstructions =
      opts.developerInstructions ?? this.developerInstructions;
    const result = (await rpc.request("thread/resume", {
      threadId,
      cwd: opts.cwd ?? this.options.cwd,
      model: opts.model,
      approvalPolicy: this.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: this.sandbox,
      config: this.restricted ? { web_search: "live" } : undefined,
      ...(developerInstructions
        ? { developerInstructions }
        : {}),
    })) as { thread?: { id?: string }; threadId?: string };
    const id = result.thread?.id ?? result.threadId ?? threadId;
    return { threadId: id };
  }

  async turnStart(
    threadId: string,
    text: string,
    opts: { model?: string; handlers?: CodexTurnHandlers } = {},
  ): Promise<CodexTurnResult> {
    if (this.activeTurn) {
      throw new Error("Codex turn already in progress");
    }
    const rpc = this.requireRpc();
    const promptSentAt = Date.now();

    return new Promise<CodexTurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failActive(new Error("Codex turn timed out"));
      }, this.promptTimeoutMs);

      this.activeTurn = {
        threadId,
        resolve,
        reject,
        handlers: opts.handlers,
        messages: [],
        webSearchCompleted: false,
        promptSentAt,
        timer,
      };

      rpc
        .request("turn/start", {
          threadId,
          input: [{ type: "text", text }],
          model: opts.model,
        })
        .then((res) => {
          const turn = (res as { turn?: { id?: string; status?: string } })?.turn;
          if (this.activeTurn) this.activeTurn.turnId = turn?.id;
        })
        .catch((err) => {
          this.failActive(err as Error);
        });
    });
  }

  async listModels(): Promise<Array<{ id: string; displayName?: string }>> {
    const rpc = this.requireRpc();
    try {
      const res = (await rpc.request("model/list", {})) as {
        models?: Array<{ id?: string; name?: string; model?: string }>;
        data?: Array<{ id?: string; name?: string; model?: string }>;
      };
      const list = res.models ?? res.data ?? [];
      return list
        .map((m) => ({
          id: String(m.id ?? m.model ?? m.name ?? ""),
          displayName: m.name,
        }))
        .filter((m) => m.id);
    } catch (err) {
      log.warn("codex-app-server:model_list_failed", {
        message: (err as Error).message,
      });
      return [];
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const p = (params && typeof params === "object" ? params : {}) as Record<
      string,
      unknown
    >;

    if (method === "item/agentMessage/delta") {
      const delta =
        typeof p.delta === "string"
          ? p.delta
          : typeof (p as { text?: string }).text === "string"
            ? (p as { text: string }).text
            : "";
      if (delta && this.activeTurn) {
        if (!this.activeTurn.firstTextAt) {
          this.activeTurn.firstTextAt = Date.now();
          this.activeTurn.handlers?.onFirstText?.();
        }
        this.activeTurn.handlers?.onPartialText?.(delta);
      }
      return;
    }

    if (method === "item/completed") {
      const item = p.item as Record<string, unknown> | undefined;
      if (!item || !this.activeTurn) return;
      if (this.restricted) {
        const forbidden = classifyForbiddenCodexItem(item);
        if (forbidden) {
          const summary = `${method}:${forbidden}`;
          this.activeTurn.handlers?.onForbiddenTool?.(summary);
          log.warn("codex-app-server:forbidden_tool", { summary });
          this.failActive(
            new Error(
              `Codex restricted mode blocked local tool activity (${forbidden}).`,
            ),
          );
          return;
        }
      }
      if (isHostedWebSearchItem(item)) {
        this.activeTurn.webSearchCompleted = true;
        log.info("codex-app-server:web_search_completed", {
          type: item.type,
        });
      }
      if (item.type === "agentMessage" && typeof item.text === "string") {
        const phase = item.phase;
        // Prefer final_answer when present; otherwise collect all agentMessage text.
        if (phase === "final_answer" || phase == null || phase === "commentary") {
          if (item.text.trim()) this.activeTurn.messages.push(item.text.trim());
        }
        if (!this.activeTurn.firstTextAt && item.text.trim()) {
          this.activeTurn.firstTextAt = Date.now();
          this.activeTurn.handlers?.onFirstText?.();
        }
      }
      return;
    }

    if (method === "item/started" && this.restricted) {
      const item = p.item as Record<string, unknown> | undefined;
      if (item && this.activeTurn) {
        const forbidden = classifyForbiddenCodexItem(item);
        if (forbidden) {
          const summary = `${method}:${forbidden}`;
          this.activeTurn.handlers?.onForbiddenTool?.(summary);
          log.warn("codex-app-server:forbidden_tool", { summary });
          this.failActive(
            new Error(
              `Codex restricted mode blocked local tool activity (${forbidden}).`,
            ),
          );
        }
      }
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const tokenUsage = p.tokenUsage as Record<string, unknown> | undefined;
      const last = (tokenUsage?.last ?? tokenUsage?.total) as
        | Record<string, unknown>
        | undefined;
      if (last && this.activeTurn) {
        this.activeTurn.usage = parseAppServerUsage(last);
      }
      return;
    }

    if (method === "turn/completed") {
      if (!this.activeTurn) return;
      const turn = p.turn as Record<string, unknown> | undefined;
      const status = typeof turn?.status === "string" ? turn.status : "completed";
      if (status === "failed" || status === "interrupted") {
        const errMsg =
          typeof (turn?.error as { message?: string } | undefined)?.message ===
          "string"
            ? (turn!.error as { message: string }).message
            : `Codex turn ${status}`;
        this.failActive(new Error(errMsg));
        return;
      }
      this.finishActive();
    }
  }

  private handleServerRequest(
    method: string,
    params: unknown,
    id: string | number,
  ): void {
    const rpc = this.rpc;
    if (!rpc) return;
    // Never silent-approve tools from QQ. Reject approval/permission requests.
    if (
      /approval|permission|userInput|elicitation/i.test(method)
    ) {
      const summary = `${method}`;
      this.activeTurn?.handlers?.onPermission?.(summary);
      log.info("codex-app-server:reject_server_request", { method });
      try {
        rpc.respondError(id, {
          code: -32000,
          message: "rejected by qq-cli-bridge (no silent tool approval)",
        });
      } catch {
        // ignore
      }
      return;
    }
    // Acknowledge unknown server requests without granting tools.
    try {
      rpc.respond(id, {});
    } catch {
      // ignore
    }
  }

  private finishActive(): void {
    const cur = this.activeTurn;
    if (!cur) return;
    clearTimeout(cur.timer);
    this.activeTurn = undefined;
    // Prefer last agentMessage (usually final_answer) when multiple exist.
    const rawText =
      cur.messages.length > 0
        ? cur.messages.length === 1
          ? cur.messages[0]!
          : cur.messages.join("\n\n")
        : "";
    const text = this.restricted
      ? applyCodexWebSearchHonesty(rawText, cur.webSearchCompleted)
      : rawText;
    cur.resolve({
      text,
      threadId: cur.threadId,
      turnId: cur.turnId,
      usage: cur.usage,
      webSearchCompleted: cur.webSearchCompleted,
      metrics: {
        promptSentAt: cur.promptSentAt,
        firstTextAt: cur.firstTextAt,
        finalAt: Date.now(),
      },
    });
  }

  private failActive(err: Error): void {
    const cur = this.activeTurn;
    if (!cur) return;
    clearTimeout(cur.timer);
    this.activeTurn = undefined;
    cur.reject(err);
  }

  private requireRpc(): NdjsonJsonRpcClient {
    if (!this.rpc || this.rpc.isClosed || !this.ready) {
      throw new Error("Codex app-server not ready");
    }
    return this.rpc;
  }
}

/**
 * Local execution / MCP / computer-use style items are forbidden in QQ-restricted mode.
 * Hosted web_search variants are explicitly allowed.
 */
/**
 * Prevent false "I searched" claims when no hosted web_search item completed.
 * Leaves honest failure admissions and plain knowledge answers unchanged.
 */
export function applyCodexWebSearchHonesty(
  text: string,
  webSearchCompleted: boolean,
): string {
  if (webSearchCompleted || !text.trim()) return text;
  const claimsSuccess =
    /我(刚)?(查|搜)(了|过|到)|根据搜索|搜索结果|网上查到|I (just )?searched|according to (my |the )?search|based on (my |a )?search|I found (online|on the (web|internet))/i.test(
      text,
    );
  const admitsFailure =
    /不可用|没查成|搜索失败|无法搜索|未能搜索|没有搜索|couldn't (access|use|search)|could not search|search (is |was )?(unavailable|failed)|no web search/i.test(
      text,
    );
  if (!claimsSuccess || admitsFailure) return text;
  return (
    "这次没有完成真实的网页搜索，刚才那句等于没核实。你可以再问一次，我会用托管搜索重试。"
  );
}

export function classifyForbiddenCodexItem(
  item: Record<string, unknown>,
): string | null {
  const type = typeof item.type === "string" ? item.type : "";
  if (isHostedWebSearchItem(item)) return null;
  if (type === "agentMessage" || type === "reasoning" || type === "error") return null;
  if (
    /^(command|shell|fileChange|mcpToolCall|mcp|dynamicToolCall|collab|imageView|imageGeneration|sleep|browser|computerUse|codeMode)/i.test(
      type,
    )
  ) {
    return type;
  }
  const tool = typeof item.tool === "string" ? item.tool : "";
  if (/shell|exec|apply_patch|mcp|browser|computer/i.test(tool)) return tool;
  return null;
}

export function isHostedWebSearchItem(item: Record<string, unknown>): boolean {
  const type = typeof item.type === "string" ? item.type : "";
  if (/^web_?search/i.test(type)) return true;
  if (type === "web_search_call" || type === "webSearchCall") return true;
  const tool = typeof item.tool === "string" ? item.tool : "";
  if (/^web_?search$/i.test(tool)) return true;
  // Nested action payloads from JSONL / app-server.
  const action = item.action as { type?: string } | undefined;
  if (action && /search/i.test(String(action.type ?? "")) && /web/i.test(type + tool)) {
    return true;
  }
  return false;
}

function parseAppServerUsage(raw: Record<string, unknown>): CodexAppServerUsage {
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  return {
    inputTokens: num(raw.inputTokens) ?? num(raw.input_tokens),
    cachedInputTokens:
      num(raw.cachedInputTokens) ?? num(raw.cached_input_tokens),
    cacheWriteInputTokens:
      num(raw.cacheWriteInputTokens) ?? num(raw.cache_write_input_tokens),
    outputTokens: num(raw.outputTokens) ?? num(raw.output_tokens),
    reasoningOutputTokens:
      num(raw.reasoningOutputTokens) ?? num(raw.reasoning_output_tokens),
    totalTokens: num(raw.totalTokens) ?? num(raw.total_tokens),
  };
}

export { JsonRpcError };
