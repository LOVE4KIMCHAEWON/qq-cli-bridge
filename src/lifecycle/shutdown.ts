import { ownedChildren } from "./child-registry.js";
import { releaseInstanceLock } from "./instance-lock.js";
import { log } from "../util/logger.js";

type StopFn = () => Promise<void>;

let stopRuntime: StopFn | undefined;
let installed = false;
let shuttingDown = false;

export function setShutdownRuntimeStop(fn: StopFn): void {
  stopRuntime = fn;
}

export async function gracefulShutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[qqbridge] Stopping (${reason})…`);
  log.info("lifecycle:shutdown_begin", { reason, pid: process.pid });

  // Stop runtime first so ACP can cancel in-flight turns and close cleanly.
  try {
    await stopRuntime?.();
  } catch (err) {
    log.warn("lifecycle:runtime_stop_error", { message: (err as Error).message });
  }

  // Then force-reap any remaining owned children (ACP/oneshot leftovers).
  try {
    ownedChildren.stopOwned(false);
    const soft = await ownedChildren.waitUntilEmpty(2000);
    if (soft.remaining.length) {
      log.warn("lifecycle:force_kill_remaining", { pids: soft.remaining });
      ownedChildren.stopOwned(true);
      const hard = await ownedChildren.waitUntilEmpty(2000);
      if (hard.remaining.length) {
        log.error("lifecycle:orphan_owned_children", { pids: hard.remaining });
      }
    }
  } catch (err) {
    log.warn("lifecycle:child_stop_error", { message: (err as Error).message });
  }

  try {
    releaseInstanceLock();
  } catch (err) {
    log.warn("lifecycle:lock_release_error", { message: (err as Error).message });
  }

  const leftover = ownedChildren.listAlivePids();
  log.info("lifecycle:shutdown_complete", {
    reason,
    ownedAlive: leftover.length,
    ownedPids: leftover,
  });
}

/** Install once — Ctrl+C / SIGTERM / beforeExit. */
export function installProcessLifecycleHandlers(): void {
  if (installed) return;
  installed = true;

  const run = (reason: string) => {
    void gracefulShutdown(reason).finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", () => run("SIGINT"));
  process.on("SIGTERM", () => run("SIGTERM"));
  // Windows Ctrl+Break
  process.on("SIGBREAK", () => run("SIGBREAK"));

  process.on("uncaughtException", (err) => {
    log.error("lifecycle:uncaughtException", { message: err.message });
    void gracefulShutdown("uncaughtException").finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    log.error("lifecycle:unhandledRejection", {
      message: reason instanceof Error ? reason.message : String(reason),
    });
  });

  // Last-resort sync release if event loop is draining.
  process.on("exit", () => {
    try {
      ownedChildren.stopOwned(true);
    } catch {
      // ignore
    }
    try {
      releaseInstanceLock();
    } catch {
      // ignore
    }
  });
}
