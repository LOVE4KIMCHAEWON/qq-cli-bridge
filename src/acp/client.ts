import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import readline from "node:readline";
import { JsonRpcError, NdjsonJsonRpcClient } from "./jsonrpc-client.js";
import type {
  AcpConfigOption,
  AcpPermissionMode,
  AcpPromptResult,
  AcpSessionMode,
  AcpSessionSetup,
  AcpTurnMetrics,
} from "./types.js";
import { isPidAlive, terminatePid } from "../lifecycle/process-info.js";
import { resolveSpawnPlan, spawnWithPlan } from "../util/process.js";
import { log } from "../util/logger.js";
import { sanitizeExtraArgs, scrubAgentEnv } from "../security/chat-only.js";

export interface AcpSpawnedProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  pid?: number;
  killed: boolean;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface AcpClientOptions {
  command: string;
  extraArgs?: string[];
  cwd: string;
  permissionMode?: AcpPermissionMode;
  /** Preferred session mode applied after session/new when supported. */
  sessionMode?: AcpSessionMode;
  promptTimeoutMs?: number;
  initTimeoutMs?: number;
  /** Test seam — inject a fake ACP process instead of spawning. */
  spawnProcess?: () => AcpSpawnedProcess | Promise<AcpSpawnedProcess>;
}

export interface AcpPromptHandlers {
  onPartialText?: (text: string) => void;
  onFirstText?: () => void;
  onPermission?: (summary: string) => void;
  onStatus?: (text: string) => void;
}

/**
 * Persistent Cursor ACP process client.
 * One process; many sessions via session/new | session/load.
 */
export class CursorAcpClient {
  private child?: AcpSpawnedProcess;
  private rpc?: NdjsonJsonRpcClient;
  private stderrRl?: readline.Interface;
  private initStartedAt = 0;
  private initCompletedAt = 0;
  private ready = false;
  private crashing = false;
  /** Last unknown-completion flag — caller must not auto-replay. */
  lastTurnCompletionUnknown = false;
  private permissionMode: AcpPermissionMode;
  private readonly promptTimeoutMs: number;
  private readonly initTimeoutMs: number;
  private activePromptSessionId?: string;
  private activeAssistant = "";
  private firstTextSeen = false;
  private permissionNotes: string[] = [];
  private sessionConfig = new Map<string, AcpConfigOption[]>();
  /** Sessions already active on this live ACP connection (skip redundant load). */
  private liveSessions = new Set<string>();
  private turnUsageUpdates: unknown[] = [];
  private turnToolNotifications = 0;
  private turnAssistantChunks = 0;
  private stopping = false;

  constructor(private readonly options: AcpClientOptions) {
    // Chat-only: always reject tool permissions — never allow-once from QQ.
    this.permissionMode = "reject";
    void options.permissionMode;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 10 * 60_000;
    this.initTimeoutMs = options.initTimeoutMs ?? 120_000;
  }

  get isReady(): boolean {
    return this.ready && !!this.rpc && !this.rpc.isClosed && !this.stopping;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** True when this connection already has the ACP session loaded/created. */
  hasLiveSession(sessionId: string): boolean {
    return this.liveSessions.has(sessionId);
  }

  get initDurationMs(): number | undefined {
    if (!this.initCompletedAt || !this.initStartedAt) return undefined;
    return this.initCompletedAt - this.initStartedAt;
  }

  async start(): Promise<{ initMs: number }> {
    if (this.ready && this.rpc && !this.rpc.isClosed && !this.stopping) {
      return { initMs: this.initDurationMs ?? 0 };
    }
    await this.stop();
    this.stopping = false;
    this.crashing = false;
    this.lastTurnCompletionUnknown = false;
    this.liveSessions.clear();
    this.initStartedAt = Date.now();

    const child = this.options.spawnProcess
      ? await this.options.spawnProcess()
      : await (async () => {
          const args = [...sanitizeExtraArgs(this.options.extraArgs ?? []), "acp"];
          const plan = await resolveSpawnPlan(this.options.command, args);
          return spawnWithPlan(plan, {
            cwd: this.options.cwd,
            env: scrubAgentEnv(),
            stdio: ["pipe", "pipe", "pipe"],
          }) as ChildProcess;
        })();
    this.child = child;

    if (!child.stdin || !child.stdout) {
      throw new Error("ACP process missing stdio pipes");
    }

    const rpc = new NdjsonJsonRpcClient(child.stdin, child.stdout, {
      defaultTimeoutMs: this.promptTimeoutMs,
    });
    this.rpc = rpc;

    rpc.on("notification", (method, params, raw) => {
      void this.handleServerMessage(method, params, raw);
    });
    rpc.on("close", () => {
      this.ready = false;
      if (this.activePromptSessionId) {
        this.lastTurnCompletionUnknown = true;
        this.crashing = true;
      }
    });
    rpc.on("parse_error", (err, line) => {
      log.warn("acp:parse_error", {
        message: (err as Error).message,
        linePreview: String(line).slice(0, 80),
      });
    });

    if (child.stderr) {
      this.stderrRl = readline.createInterface({ input: child.stderr });
      this.stderrRl.on("line", (line) => {
        log.debug("acp:stderr", { line: line.slice(0, 200) });
      });
    }

    child.on("exit", (code, signal) => {
      log.warn("acp:process_exit", { code, signal });
      this.ready = false;
      this.rpc?.close("process_exit");
      if (this.activePromptSessionId) {
        this.lastTurnCompletionUnknown = true;
        this.crashing = true;
      }
    });

    await rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: { parameterizedModelPicker: true },
        },
        clientInfo: { name: "qq-cli-bridge", version: "0.1.0" },
      },
      this.initTimeoutMs,
    );

    await rpc.request(
      "authenticate",
      { methodId: "cursor_login" },
      this.initTimeoutMs,
    );

    this.initCompletedAt = Date.now();
    this.ready = true;
    const initMs = this.initCompletedAt - this.initStartedAt;
    log.info("acp:initialized", { initMs });
    return { initMs };
  }

  async stop(): Promise<void> {
    if (this.stopping && !this.child) return;
    this.stopping = true;
    this.ready = false;
    const active = this.activePromptSessionId;
    this.activePromptSessionId = undefined;
    try {
      if (active && this.rpc && !this.rpc.isClosed) {
        this.rpc.notify("session/cancel", { sessionId: active });
      }
    } catch {
      // ignore
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
      log.warn("acp:force_terminate", { pid });
      terminatePid(pid, true);
      await new Promise((r) => setTimeout(r, 300));
    }
    if (pid && isPidAlive(pid)) {
      log.error("acp:orphan_process", { pid });
    } else if (pid) {
      log.info("acp:process_stopped", { pid });
    }
    this.sessionConfig.clear();
    this.liveSessions.clear();
  }

  async ensureStarted(): Promise<{ initMs: number; cold: boolean }> {
    if (this.isReady) return { initMs: 0, cold: false };
    const { initMs } = await this.start();
    return { initMs, cold: true };
  }

  async sessionNew(cwd: string): Promise<AcpSessionSetup> {
    const rpc = this.requireRpc();
    const result = (await rpc.request("session/new", {
      cwd,
      mcpServers: [],
    })) as AcpSessionSetup;
    if (!result?.sessionId) throw new Error("ACP session/new returned no sessionId");
    this.sessionConfig.set(result.sessionId, result.configOptions ?? []);
    this.liveSessions.add(result.sessionId);
    if (this.options.sessionMode && this.options.sessionMode !== "agent") {
      await this.setSessionMode(result.sessionId, this.options.sessionMode);
    }
    return result;
  }

  async sessionLoad(sessionId: string, cwd: string): Promise<AcpSessionSetup> {
    // Avoid redundant load/replay when session is already live on this connection.
    if (this.liveSessions.has(sessionId) && this.sessionConfig.has(sessionId)) {
      return {
        sessionId,
        configOptions: this.sessionConfig.get(sessionId),
      };
    }
    const rpc = this.requireRpc();
    const result = (await rpc.request("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
    })) as AcpSessionSetup;
    const sid = result?.sessionId || sessionId;
    this.sessionConfig.set(sid, result.configOptions ?? []);
    this.liveSessions.add(sid);
    return { ...result, sessionId: sid };
  }

  async setSessionMode(sessionId: string, mode: AcpSessionMode): Promise<void> {
    const rpc = this.requireRpc();
    const options = this.sessionConfig.get(sessionId) ?? [];
    const modeOpt =
      options.find((o) => o.category === "mode") ||
      options.find((o) => o.configId === "mode");
    if (!modeOpt) {
      log.warn("acp:mode_option_unavailable", { mode });
      return;
    }
    const current =
      typeof modeOpt.currentValue === "string" ? modeOpt.currentValue : undefined;
    if (current === mode) return;
    try {
      const updated = (await rpc.request("session/set_config_option", {
        sessionId,
        configId: modeOpt.configId,
        value: mode,
      })) as { configOptions?: AcpConfigOption[] };
      if (updated?.configOptions) this.sessionConfig.set(sessionId, updated.configOptions);
      log.info("acp:mode_set", { mode, sessionId: sessionId.slice(0, 8) });
    } catch (err) {
      throw new Error(`ACP refused mode "${mode}": ${(err as Error).message}`);
    }
  }

  /**
   * Apply model via session/set_config_option when advertised.
   * Throws if the model cannot be applied — never silently keeps the wrong model.
   */
  async setModel(sessionId: string, modelId: string | undefined): Promise<string | undefined> {
    const rpc = this.requireRpc();
    const options = this.sessionConfig.get(sessionId) ?? [];
    const modelOpt =
      options.find((o) => o.category === "model") ||
      options.find((o) => o.configId === "model");

    if (!modelId || modelId === "default" || modelId === "auto") {
      if (!modelOpt) return modelId;
      // Prefer leaving the session on its current default when already auto/default.
      const current =
        typeof modelOpt.currentValue === "string" ? modelOpt.currentValue : undefined;
      if (
        !modelId ||
        modelId === "default" ||
        (modelId === "auto" && (!current || /auto/i.test(current)))
      ) {
        return current ?? "auto";
      }
      const defaultValue = this.pickDefaultModelValue(modelOpt) ?? current ?? "auto";
      const updated = (await rpc.request("session/set_config_option", {
        sessionId,
        configId: modelOpt.configId,
        value: defaultValue,
      })) as { configOptions?: AcpConfigOption[] };
      if (updated?.configOptions) this.sessionConfig.set(sessionId, updated.configOptions);
      return typeof defaultValue === "string" ? defaultValue : modelId;
    }

    if (modelOpt) {
      try {
        const updated = (await rpc.request("session/set_config_option", {
          sessionId,
          configId: modelOpt.configId,
          value: modelId,
        })) as { configOptions?: AcpConfigOption[] };
        if (updated?.configOptions) this.sessionConfig.set(sessionId, updated.configOptions);
        return modelId;
      } catch (err) {
        throw new Error(
          `ACP refused model "${modelId}" via set_config_option: ${(err as Error).message}`,
        );
      }
    }

    // Legacy fallback — only when configOptions absent
    try {
      await rpc.request("session/set_model", { sessionId, modelId });
      return modelId;
    } catch (err) {
      if (err instanceof JsonRpcError && err.code === -32601) {
        throw new Error(
          `ACP has no model config option and session/set_model is unsupported; cannot apply "${modelId}".`,
        );
      }
      throw new Error(`ACP model switch failed for "${modelId}": ${(err as Error).message}`);
    }
  }

  async prompt(
    sessionId: string,
    text: string,
    handlers: AcpPromptHandlers = {},
  ): Promise<{ text: string; result: AcpPromptResult; metrics: AcpTurnMetrics }> {
    const rpc = this.requireRpc();
    if (this.crashing) {
      throw new Error(
        "ACP process crashed during a prior turn with unknown completion; not auto-replaying. Send a new message after recovery.",
      );
    }

    this.activePromptSessionId = sessionId;
    this.activeAssistant = "";
    this.firstTextSeen = false;
    this.permissionNotes = [];
    this.lastTurnCompletionUnknown = false;
    this.turnUsageUpdates = [];
    this.turnToolNotifications = 0;
    this.turnAssistantChunks = 0;

    const metrics: AcpTurnMetrics = {
      promptSentAt: Date.now(),
      usageUpdates: [],
      toolCallNotifications: 0,
      assistantChunkCount: 0,
    };

    const onPartial = (chunk: string) => {
      this.activeAssistant += chunk;
      if (!this.firstTextSeen && chunk.trim()) {
        this.firstTextSeen = true;
        metrics.firstTextAt = Date.now();
        handlers.onFirstText?.();
      }
      handlers.onPartialText?.(chunk);
    };
    this.partialHandler = onPartial;
    this.permissionHandler = handlers.onPermission;

    try {
      const result = (await rpc.request(
        "session/prompt",
        {
          sessionId,
          prompt: [{ type: "text", text }],
        },
        this.promptTimeoutMs,
      )) as AcpPromptResult;
      metrics.finalAt = Date.now();
      metrics.usageUpdates = [...this.turnUsageUpdates];
      metrics.resultUsage = result?.usage;
      metrics.toolCallNotifications = this.turnToolNotifications;
      metrics.assistantChunkCount = this.turnAssistantChunks;
      const out = this.activeAssistant.trim();

      // Permission diagnostics stay in logs only — never append to QQ-visible text.
      if (this.permissionNotes.length) {
        log.info("acp:permissions_rejected_summary", {
          count: this.permissionNotes.length,
          samples: this.permissionNotes.slice(0, 5).map((s) => s.slice(0, 80)),
          hadAssistantText: Boolean(out),
        });
      }

      if (out) {
        return { text: out, result, metrics };
      }

      // No assistant text: give a concise user-facing reason when tools were denied.
      if (this.permissionNotes.length && this.permissionMode === "reject") {
        return {
          text: "I couldn't finish that because tool use is disabled for this bot. Ask the operator to set acpPermission=allow-once if tools are required.",
          result,
          metrics,
        };
      }
      return {
        text: "(empty ACP response)",
        result,
        metrics,
      };
    } catch (err) {
      if (this.crashing || this.lastTurnCompletionUnknown) {
        throw new Error(
          `ACP turn ended with unknown completion (process may have crashed). Not auto-retrying. ${(err as Error).message}`,
        );
      }
      // Cancel best-effort on timeout
      try {
        rpc.notify("session/cancel", { sessionId });
      } catch {
        // ignore
      }
      throw err;
    } finally {
      this.activePromptSessionId = undefined;
      this.partialHandler = undefined;
      this.permissionHandler = undefined;
      // Clear crash latch only after a clean completion path reset by ensureStarted
    }
  }

  /** Clear unknown-completion latch after an explicit recovery restart. */
  clearCrashLatch(): void {
    this.crashing = false;
    this.lastTurnCompletionUnknown = false;
  }

  private partialHandler?: (text: string) => void;
  private permissionHandler?: (summary: string) => void;

  private async handleServerMessage(
    method: string,
    params: unknown,
    raw: unknown,
  ): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) return;

    if (method === "session/update") {
      const update = (params as { update?: Record<string, unknown> })?.update;
      if (!update) return;
      const kind = String(update.sessionUpdate ?? "");
      if (kind === "agent_message_chunk" || kind === "agent_message") {
        this.turnAssistantChunks++;
        const content = update.content as { text?: string } | undefined;
        const text =
          (content && typeof content.text === "string" && content.text) ||
          (typeof update.text === "string" ? update.text : "");
        if (text) this.partialHandler?.(text);
      } else if (kind === "usage_update") {
        this.turnUsageUpdates.push(update);
      } else if (kind === "state_update" && update.usage != null) {
        this.turnUsageUpdates.push(update);
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        this.turnToolNotifications++;
      }
      return;
    }

    if (method === "session/request_permission") {
      const id = (raw as { id?: number | string }).id;
      const summary = this.summarizePermission(params);
      this.permissionHandler?.(summary);
      this.permissionNotes.push(summary);
      if (id === undefined || id === null) return;
      const optionId =
        this.permissionMode === "allow-once" ? "allow-once" : "reject-once";
      if (this.permissionMode === "reject") {
        log.info("acp:permission_rejected", { summary: summary.slice(0, 120) });
      }
      rpc.respond(id, {
        outcome: { outcome: "selected", optionId },
      });
      return;
    }

    // Cursor extension methods — never hang the agent
    if (method === "cursor/ask_question") {
      const id = (raw as { id?: number | string }).id;
      if (id !== undefined && id !== null) {
        rpc.respond(id, { outcome: { outcome: "skipped", reason: "QQ bridge has no interactive UI" } });
      }
      return;
    }
    if (method === "cursor/create_plan") {
      const id = (raw as { id?: number | string }).id;
      if (id !== undefined && id !== null) {
        rpc.respond(id, { outcome: { outcome: "cancelled" } });
      }
      return;
    }
    // Notifications: cursor/update_todos, cursor/task, cursor/generate_image — ignore
  }

  private summarizePermission(params: unknown): string {
    if (!params || typeof params !== "object") return "tool permission";
    const p = params as Record<string, unknown>;
    const tool =
      (typeof p.toolCallId === "string" && p.toolCallId) ||
      (typeof p.title === "string" && p.title) ||
      "tool";
    return String(tool).slice(0, 80);
  }

  private pickDefaultModelValue(opt: AcpConfigOption): string | undefined {
    if (typeof opt.currentValue === "string") return opt.currentValue;
    const options = opt.options ?? [];
    for (const o of options) {
      const v = typeof o === "string" ? o : o.value;
      if (v === "auto" || v.toLowerCase() === "auto") return v;
    }
    if (options.length) {
      const first = options[0]!;
      return typeof first === "string" ? first : first.value;
    }
    return undefined;
  }

  private requireRpc(): NdjsonJsonRpcClient {
    if (!this.rpc || this.rpc.isClosed || !this.ready) {
      throw new Error("ACP client is not ready");
    }
    return this.rpc;
  }
}
