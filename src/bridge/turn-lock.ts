import fs from "node:fs";
import { ensureDataDirs, lockPath } from "../paths.js";

/**
 * Serializes agent turns.
 * Acquire is synchronous when free so two concurrent inbound handlers cannot
 * both pass an isBusy()/acquire race via `await Promise.resolve()`.
 */
export class TurnLock {
  private queue: Array<() => void> = [];
  private held = false;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      this.writeLockFile(true);
      return await fn();
    } finally {
      this.writeLockFile(false);
      this.release();
    }
  }

  isBusy(): boolean {
    return this.held;
  }

  private acquire(): Promise<void> {
    if (!this.held) {
      this.held = true;
      // Return a thenable that does NOT microtask-yield before held is set.
      // held is already true synchronously above.
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.held = true;
        resolve();
      });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.held = false;
  }

  private writeLockFile(busy: boolean): void {
    ensureDataDirs();
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ busy, pid: process.pid, at: new Date().toISOString() }, null, 2),
      "utf8",
    );
  }
}

export const globalTurnLock = new TurnLock();
