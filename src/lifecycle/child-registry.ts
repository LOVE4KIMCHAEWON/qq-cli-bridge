import type { ChildProcess } from "node:child_process";
import { isPidAlive, terminatePid } from "./process-info.js";
import { log } from "../util/logger.js";

/**
 * Tracks child processes spawned by this qqbridge instance only.
 * Shutdown must not kill unrelated gemini/claude/codex/cursor processes.
 */
class ChildRegistry {
  private readonly children = new Map<number, ChildProcess>();

  track(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) return;
    this.children.set(pid, child);
    const forget = () => this.children.delete(pid);
    child.once("exit", forget);
    child.once("error", forget);
  }

  listPids(): number[] {
    return [...this.children.keys()];
  }

  /** Alive owned PIDs only (for lifecycle tests). */
  listAlivePids(): number[] {
    return this.listPids().filter((pid) => isPidAlive(pid));
  }

  /**
   * Terminate tracked children that are still alive.
   * Returns PIDs that were signalled.
   */
  stopOwned(force = false): number[] {
    const signalled: number[] = [];
    for (const [pid, child] of this.children) {
      try {
        if (!isPidAlive(pid)) {
          this.children.delete(pid);
          continue;
        }
        log.info("lifecycle:stop_owned_child", { pid, force });
        signalled.push(pid);
        if (!child.killed) {
          try {
            child.kill(force ? "SIGKILL" : "SIGTERM");
          } catch {
            terminatePid(pid, force);
          }
        }
      } catch (err) {
        log.warn("lifecycle:stop_owned_child_failed", {
          pid,
          message: (err as Error).message,
        });
      } finally {
        this.children.delete(pid);
      }
    }
    return signalled;
  }

  /** Wait until owned children are gone (or timeout). */
  async waitUntilEmpty(timeoutMs = 5000): Promise<{ remaining: number[] }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const alive = this.listAlivePids();
      if (alive.length === 0) return { remaining: [] };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { remaining: this.listAlivePids() };
  }
}

export const ownedChildren = new ChildRegistry();
