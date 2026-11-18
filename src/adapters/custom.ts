import type {
  AgentAdapter,
  AgentOptions,
  AgentOutput,
  AgentTurnHooks,
  AgentTurnOptions,
} from "../types.js";
import type { ModelCatalog, ModelSwitchResult } from "../models/types.js";
import { runCommand, spawnInteractive, tryLoadNodePty } from "../util/process.js";
import { sanitizeForQq } from "../util/output-filter.js";

/**
 * Custom CLI adapter.
 * Default: PTY/stdin inject when node-pty is available; otherwise one-shot command runs.
 * Session resume only if the user provides sessionResumeTemplate with {sessionId} and {message}.
 */
export class CustomAdapter implements AgentAdapter {
  readonly kind = "custom" as const;
  readonly displayName: string;
  readonly supportsSessionResume: boolean;

  private command: string;
  private args: string[];
  private sessionResumeTemplate?: string;
  private options?: AgentOptions;
  private sessionId?: string;
  private listeners: Array<(output: AgentOutput) => void> = [];
  private pty: ReturnType<NonNullable<ReturnType<typeof tryLoadNodePty>>["spawn"]> | undefined;
  private buffer = "";
  private pending?: {
    resolve: (text: string) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  };

  constructor(
    name: string,
    command: string,
    args: string[],
    sessionResumeTemplate?: string,
  ) {
    this.displayName = `Custom:${name}`;
    this.command = command;
    this.args = args;
    this.sessionResumeTemplate = sessionResumeTemplate;
    this.supportsSessionResume = Boolean(sessionResumeTemplate);
  }

  onOutput(callback: (output: AgentOutput) => void): void {
    this.listeners.push(callback);
  }

  private emit(output: AgentOutput): void {
    for (const cb of this.listeners) cb(output);
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  async start(options: AgentOptions): Promise<void> {
    this.options = options;
    this.sessionId = options.sessionId ?? `custom-${Date.now()}`;

    if (this.supportsSessionResume) {
      this.emit({ kind: "status", text: "Custom session-resume mode", sessionId: this.sessionId });
      return;
    }

    const ptyApi = tryLoadNodePty();
    if (!ptyApi) {
      this.emit({
        kind: "status",
        text: "node-pty unavailable; custom commands will run as one-shot processes",
        sessionId: this.sessionId,
      });
      return;
    }

    this.pty = ptyApi.spawn(this.command, this.args, {
      name: "xterm-color",
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 30,
      cwd: options.cwd,
      env: process.env,
    });

    this.pty.onData((data) => {
      process.stdout.write(data);
      this.buffer += data;
      this.maybeSettlePending();
    });

    this.emit({ kind: "status", text: "Custom PTY started", sessionId: this.sessionId });
  }

  async send(message: string, sessionId: string): Promise<void> {
    await this.sendAndCollect(message, sessionId);
  }

  async sendAndCollect(
    message: string,
    sessionId: string,
    hooks?: AgentTurnHooks,
    _turn?: AgentTurnOptions,
  ): Promise<string> {
    const sid = sessionId || this.sessionId || "custom";
    this.sessionId = sid;

    if (this.sessionResumeTemplate) {
      const rendered = this.sessionResumeTemplate
        .replaceAll("{sessionId}", sid)
        .replaceAll("{message}", message)
        .replaceAll("{modelId}", _turn?.modelId ?? "");
      const parts = rendered.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
      const [cmd, ...args] = parts.map((p) => p.replace(/^"|"$/g, ""));
      hooks?.onSpawn?.();
      const result = await runCommand(cmd, args, {
        cwd: this.options?.cwd,
        timeoutMs: 10 * 60_000,
      });
      const text = sanitizeForQq(result.stdout || result.stderr || "(empty)");
      this.emit({ kind: "final", text, sessionId: sid });
      hooks?.onFinal?.();
      return text;
    }

    if (this.pty) {
      this.buffer = "";
      hooks?.onSpawn?.();
      const text = await new Promise<string>((resolve, reject) => {
        this.pending = {
          resolve,
          reject,
          timer: setTimeout(() => {
            resolve(sanitizeForQq(this.buffer) || "(no output captured)");
            this.pending = undefined;
          }, 120_000),
        };
        this.pty!.write(message.endsWith("\n") ? message : message + "\r");
      });
      const clean = sanitizeForQq(text);
      this.emit({ kind: "final", text: clean, sessionId: sid });
      hooks?.onFinal?.();
      return clean;
    }

    hooks?.onSpawn?.();
    const result = await runCommand(this.command, [...this.args, message], {
      cwd: this.options?.cwd,
      timeoutMs: 10 * 60_000,
    });
    const text = sanitizeForQq(result.stdout || result.stderr || "(empty)");
    this.emit({ kind: "final", text, sessionId: sid });
    hooks?.onFinal?.();
    return text;
  }

  async stop(): Promise<void> {
    this.pty?.kill();
    this.pty = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = undefined;
    }
  }

  async attachTerminal(options: AgentOptions): Promise<number> {
    return spawnInteractive(this.command, this.args, {
      cwd: options.cwd,
      env: options.env,
    });
  }

  async listModels(): Promise<ModelCatalog> {
    return {
      backend: this.displayName,
      discovery: "unavailable",
      models: [],
      note: "Custom adapters do not support dynamic model discovery. Configure the CLI command/args instead.",
    };
  }

  async resolveModelSwitch(modelId: string | "default"): Promise<ModelSwitchResult> {
    if (modelId === "default" || modelId.toLowerCase() === "default") {
      return {
        ok: true,
        effectiveModelId: undefined,
        message: "Cleared conversation model preference for this custom adapter.",
      };
    }
    return {
      ok: false,
      message: `Model switching is not supported for ${this.displayName}.`,
    };
  }

  private maybeSettlePending(): void {
    if (!this.pending) return;
    // Heuristic: idle pause after output
    const snapshot = this.buffer;
    setTimeout(() => {
      if (!this.pending) return;
      if (this.buffer === snapshot && snapshot.trim()) {
        clearTimeout(this.pending.timer);
        const resolve = this.pending.resolve;
        this.pending = undefined;
        resolve(sanitizeForQq(snapshot));
      }
    }, 1500);
  }
}
