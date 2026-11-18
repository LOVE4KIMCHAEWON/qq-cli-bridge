import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import readline from "node:readline";
import { NdjsonJsonRpcClient } from "../acp/jsonrpc-client.js";
import type { AcpPermissionMode, AcpPromptResult, AcpSessionSetup, AcpTurnMetrics } from "../acp/types.js";
import { isPidAlive, terminatePid } from "../lifecycle/process-info.js";
import { ownedChildren } from "../lifecycle/child-registry.js";
import { resolveSpawnPlan, spawnWithPlan } from "../util/process.js";
import { log } from "../util/logger.js";
import { sanitizeExtraArgs, scrubAgentEnv } from "../security/chat-only.js";

export interface GeminiAcpSpawned {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  pid?: number;
  killed: boolean;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface GeminiAcpClientOptions {
  command: string;
  extraArgs?: string[];
  cwd: string;
  permissionMode?: AcpPermissionMode;
  promptTimeoutMs?: number;
  initTimeoutMs?: number;
  spawnProcess?: () => GeminiAcpSpawned | Promise<GeminiAcpSpawned>;
}

export interface GeminiAcpPromptHandlers {
  onPartialText?: (text: string) => void;
  onFirstText?: () => void;
  onPermission?: (summary: string) => void;
}

/**
 * Gemini CLI ACP client (`gemini --acp`).
 * Standard Agent Client Protocol over NDJSON JSON-RPC — no Cursor auth.
 */
export class GeminiAcpClient {
  private child?: GeminiAcpSpawned;
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
  private readonly permissionMode: AcpPermissionMode;
  private liveSessions = new Set<string>();
  private activePromptSessionId?: string;
  private activeAssistant = "";
  private firstTextSeen = false;
  private turnUsageUpdates: unknown[] = [];
  private turnToolNotifications = 0;
  private turnAssistantChunks = 0;
  private partialHandler?: (text: string) => void;
  private permissionHandler?: (summary: string) => void;

  constructor(private readonly options: GeminiAcpClientOptions) {
    // Chat-only: always reject tool permissions.
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
    this.liveSessions.clear();
    this.initStartedAt = Date.now();

    const child = this.options.spawnProcess
      ? await this.options.spawnProcess()
      : await (async () => {
          const args = [...sanitizeExtraArgs(this.options.extraArgs ?? []), "--acp"];
          const plan = await resolveSpawnPlan(this.options.command, args);
          const proc = spawnWithPlan(plan, {
            cwd: this.options.cwd,
            env: scrubAgentEnv(),
            stdio: ["pipe", "pipe", "pipe"],
          }) as ChildProcess;
          ownedChildren.track(proc);
          return proc as unknown as GeminiAcpSpawned;
        })();
    this.child = child;

    if (!child.stdin || !child.stdout) {
      throw new Error("Gemini ACP process missing stdio pipes");
    }

    const rpc = new NdjsonJsonRpcClient(child.stdin, child.stdout, {
      defaultTimeoutMs: this.promptTimeoutMs,
    });
    this.rpc = rpc;

    rpc.on("notification", (method, params, raw) => {
      void this.handleServerMessage(String(method), params, raw);
    });
    rpc.on("close", () => {
      this.ready = false;
      if (this.activePromptSessionId) {
        this.lastTurnCompletionUnknown = true;
        this.crashing = true;
      }
    });

    if (child.stderr) {
      this.stderrRl = readline.createInterface({ input: child.stderr });
      this.stderrRl.on("line", (line) => {
        log.debug("gemini-acp:stderr", { line: line.slice(0, 200) });
      });
    }

    child.on("exit", (code, signal) => {
      log.warn("gemini-acp:process_exit", { code, signal });
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
        },
        clientInfo: { name: "qq-cli-bridge", version: "0.1.0" },
      },
      this.initTimeoutMs,
    );

    // Gemini may advertise auth methods; try common ones, ignore if unsupported.
    try {
      await rpc.request("authenticate", { methodId: "gemini" }, 15_000);
    } catch {
      try {
        await rpc.request("authenticate", { methodId: "default" }, 15_000);
      } catch {
        log.info("gemini-acp:authenticate_skipped", {
          note: "No matching auth method; continuing with initialize only",
        });
      }
    }

    this.initCompletedAt = Date.now();
    this.ready = true;
    const initMs = this.initCompletedAt - this.initStartedAt;
    log.info("gemini-acp:initialized", { initMs, pid: child.pid });
    return { initMs };
  }

  async stop(): Promise<void> {
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
      terminatePid(pid, true);
      await new Promise((r) => setTimeout(r, 300));
    }
    if (pid && isPidAlive(pid)) {
      log.error("gemini-acp:orphan_process", { pid });
    }
    this.liveSessions.clear();
  }

  async sessionNew(cwd: string): Promise<AcpSessionSetup> {
    const rpc = this.requireRpc();
    const result = (await rpc.request("session/new", {
      cwd,
      mcpServers: [],
    })) as AcpSessionSetup;
    if (!result?.sessionId) throw new Error("Gemini ACP session/new returned no sessionId");
    this.liveSessions.add(result.sessionId);
    return result;
  }

  async sessionLoad(sessionId: string, cwd: string): Promise<AcpSessionSetup> {
    if (this.liveSessions.has(sessionId)) {
      return { sessionId };
    }
    const rpc = this.requireRpc();
    const result = (await rpc.request("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
    })) as AcpSessionSetup;
    const sid = result?.sessionId || sessionId;
    this.liveSessions.add(sid);
    return { ...result, sessionId: sid };
  }

  async setModel(sessionId: string, modelId: string | undefined): Promise<string | undefined> {
    if (!modelId || modelId === "default") return modelId;
    const rpc = this.requireRpc();
    try {
      await rpc.request("session/set_config_option", {
        sessionId,
        configId: "model",
        value: modelId,
      });
      return modelId;
    } catch (err) {
      throw new Error(
        `Gemini ACP refused model "${modelId}": ${(err as Error).message}`,
      );
    }
  }

  async prompt(
    sessionId: string,
    text: string,
    handlers: GeminiAcpPromptHandlers = {},
  ): Promise<{ text: string; result: AcpPromptResult; metrics: AcpTurnMetrics }> {
    const rpc = this.requireRpc();
    if (this.crashing) {
      throw new Error(
        "Gemini ACP process crashed during a prior turn with unknown completion; not auto-replaying.",
      );
    }

    this.activePromptSessionId = sessionId;
    this.activeAssistant = "";
    this.firstTextSeen = false;
    this.lastTurnCompletionUnknown = false;
    this.turnUsageUpdates = [];
    this.turnToolNotifications = 0;
    this.turnAssistantChunks = 0;
    this.partialHandler = (chunk) => {
      this.activeAssistant += chunk;
      if (!this.firstTextSeen && chunk.trim()) {
        this.firstTextSeen = true;
        handlers.onFirstText?.();
      }
      handlers.onPartialText?.(chunk);
    };
    this.permissionHandler = handlers.onPermission;

    const metrics: AcpTurnMetrics = {
      promptSentAt: Date.now(),
      usageUpdates: this.turnUsageUpdates,
      toolCallNotifications: 0,
      assistantChunkCount: 0,
    };

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
      metrics.firstTextAt = this.firstTextSeen
        ? metrics.firstTextAt
        : undefined;
      metrics.toolCallNotifications = this.turnToolNotifications;
      metrics.assistantChunkCount = this.turnAssistantChunks;
      metrics.usageUpdates = [...this.turnUsageUpdates];

      const textOut =
        this.activeAssistant.trim() ||
        (typeof result?.stopReason === "string" ? "" : "") ||
        "";
      return { text: textOut, result: result ?? { stopReason: "end_turn" }, metrics };
    } catch (err) {
      if (this.crashing || this.lastTurnCompletionUnknown) {
        throw err;
      }
      throw err;
    } finally {
      this.activePromptSessionId = undefined;
      this.partialHandler = undefined;
      this.permissionHandler = undefined;
    }
  }

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
      } else if (kind === "usage_update" || (kind === "state_update" && update.usage != null)) {
        this.turnUsageUpdates.push(update);
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        this.turnToolNotifications++;
      }
      return;
    }

    if (method === "session/request_permission") {
      const id = (raw as { id?: number | string }).id;
      const summary = JSON.stringify(params).slice(0, 160);
      this.permissionHandler?.(summary);
      if (id === undefined || id === null) return;
      const optionId =
        this.permissionMode === "allow-once" ? "allow-once" : "reject-once";
      rpc.respond(id, {
        outcome: { outcome: "selected", optionId },
      });
    }
  }

  private requireRpc(): NdjsonJsonRpcClient {
    if (!this.rpc || this.rpc.isClosed || !this.ready) {
      throw new Error("Gemini ACP not ready");
    }
    return this.rpc;
  }
}
