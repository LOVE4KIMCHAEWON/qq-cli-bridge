import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type {
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcSuccess,
} from "./types.js";

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(error: { code: number; message: string; data?: unknown }) {
    super(error.message);
    this.name = "JsonRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
};

/**
 * Newline-delimited JSON-RPC 2.0 client (ACP framing).
 * Keeps protocol traffic isolated from ordinary CLI stdout parsers.
 */
export class NdjsonJsonRpcClient extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private buffer = "";
  private closed = false;
  private readonly defaultTimeoutMs: number;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    options: { defaultTimeoutMs?: number } = {},
  ) {
    super();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10 * 60_000;
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => this.onData(chunk));
    stdout.on("end", () => this.failAll(new Error("ACP stdout ended")));
    stdout.on("error", (err) => this.failAll(err));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("ACP JSON-RPC client closed"));
    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs ?? this.defaultTimeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      try {
        this.stdin.write(payload + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
    this.stdin.write(payload + "\n");
  }

  respond(id: JsonRpcId, result: unknown): void {
    if (this.closed) return;
    this.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n",
    );
  }

  respondError(id: JsonRpcId, error: { code: number; message: string; data?: unknown }): void {
    if (this.closed) return;
    this.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, error }) + "\n",
    );
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error(`ACP JSON-RPC client ${reason}`));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch (err) {
      this.emit("parse_error", err, line);
      return;
    }

    if ("id" in msg && msg.id != null && ("result" in msg || "error" in msg)) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        this.emit("orphan_response", msg);
        return;
      }
      this.pending.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if ("error" in msg && (msg as JsonRpcFailure).error) {
        pending.reject(new JsonRpcError((msg as JsonRpcFailure).error));
      } else {
        pending.resolve((msg as JsonRpcSuccess).result);
      }
      return;
    }

    if ("method" in msg && typeof msg.method === "string") {
      this.emit("notification", msg.method, (msg as { params?: unknown }).params, msg);
      return;
    }

    this.emit("unknown_message", msg);
  }

  private failAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
    this.emit("close", err);
  }
}
