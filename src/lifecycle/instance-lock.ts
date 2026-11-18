import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureDataDirs, dataRoot } from "../paths.js";
import { isLockOwnerActive, isPidAlive, terminatePid } from "./process-info.js";
import { log } from "../util/logger.js";

export interface InstanceLockOwner {
  v: 1;
  pid: number;
  appId: string;
  startedAt: string;
  startedAtMs: number;
  hostname: string;
  cwd: string;
  agent?: string;
}

export class InstanceLockError extends Error {
  constructor(
    message: string,
    readonly owner?: InstanceLockOwner,
  ) {
    super(message);
    this.name = "InstanceLockError";
  }
}

/** Cross-process lock directory — one holder per data dir / QQ bot credentials. */
export function instanceLockDir(): string {
  return path.join(dataRoot(), "state", "instance.lock");
}

export function instanceOwnerPath(): string {
  return path.join(instanceLockDir(), "owner.json");
}

export function readInstanceOwner(): InstanceLockOwner | undefined {
  const p = instanceOwnerPath();
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as InstanceLockOwner;
  } catch {
    return undefined;
  }
}

function writeOwner(owner: InstanceLockOwner): void {
  fs.writeFileSync(instanceOwnerPath(), JSON.stringify(owner, null, 2), "utf8");
}

function removeLockDir(): void {
  const dir = instanceLockDir();
  try {
    if (fs.existsSync(instanceOwnerPath())) fs.unlinkSync(instanceOwnerPath());
  } catch {
    // ignore
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Try to reclaim a lock only when the owner is proven inactive.
 * Never reclaim solely due to missing heartbeat / "unresponsive".
 */
function reclaimIfStale(): boolean {
  const owner = readInstanceOwner();
  if (!owner) {
    // Lock dir without owner — safe to clear.
    removeLockDir();
    return true;
  }
  const status = isLockOwnerActive({
    pid: owner.pid,
    startedAtMs: owner.startedAtMs,
  });
  if (status.active) return false;
  log.warn("lifecycle:reclaim_stale_lock", {
    pid: owner.pid,
    appId: owner.appId,
    reason: status.reason,
  });
  removeLockDir();
  return true;
}

export function acquireInstanceLock(options: {
  appId: string;
  agent?: string;
}): InstanceLockOwner {
  ensureDataDirs();
  const dir = instanceLockDir();
  const startedAtMs = Date.now();
  const owner: InstanceLockOwner = {
    v: 1,
    pid: process.pid,
    appId: options.appId,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    hostname: os.hostname(),
    cwd: process.cwd(),
    agent: options.agent,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir);
      writeOwner(owner);
      log.info("lifecycle:lock_acquired", {
        pid: owner.pid,
        appId: owner.appId,
        agent: owner.agent,
      });
      return owner;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      const existing = readInstanceOwner();
      if (existing && existing.pid === process.pid) {
        writeOwner({ ...existing, ...owner });
        return owner;
      }

      if (attempt === 0 && reclaimIfStale()) continue;

      const active = existing ?? readInstanceOwner();
      const msg = active
        ? `Another qqbridge instance is already running (pid ${active.pid}, appId ${active.appId}, agent=${active.agent ?? "unknown"}). Stop it with: qqbridge stop`
        : `Another qqbridge instance holds the lock at ${dir}. Stop it with: qqbridge stop`;
      throw new InstanceLockError(msg, active);
    }
  }

  throw new InstanceLockError(`Failed to acquire instance lock at ${dir}`);
}

export function releaseInstanceLock(): void {
  const owner = readInstanceOwner();
  if (owner && owner.pid !== process.pid) {
    // Do not delete another live process's lock.
    const status = isLockOwnerActive({
      pid: owner.pid,
      startedAtMs: owner.startedAtMs,
    });
    if (status.active) {
      log.warn("lifecycle:skip_release_foreign_lock", { pid: owner.pid });
      return;
    }
  }
  removeLockDir();
  log.info("lifecycle:lock_released", { pid: process.pid });
}

export function refreshInstanceLockAgent(agent: string): void {
  const owner = readInstanceOwner();
  if (!owner || owner.pid !== process.pid) return;
  writeOwner({ ...owner, agent });
}

/**
 * Stop the process that owns the instance lock (for `qqbridge stop`).
 * Returns whether a remote/local owner was targeted.
 */
export async function stopLockOwner(options: {
  /** Called in-process when we are the owner. */
  stopSelf?: () => Promise<void>;
  waitMs?: number;
}): Promise<{ stopped: boolean; detail: string }> {
  const owner = readInstanceOwner();
  if (!owner) {
    return { stopped: false, detail: "No instance lock found — qqbridge does not appear to be running." };
  }

  if (owner.pid === process.pid) {
    await options.stopSelf?.();
    releaseInstanceLock();
    return { stopped: true, detail: `Stopped this process (pid ${owner.pid}).` };
  }

  const status = isLockOwnerActive({
    pid: owner.pid,
    startedAtMs: owner.startedAtMs,
  });
  if (!status.active) {
    removeLockDir();
    return {
      stopped: true,
      detail: `Cleared stale lock (pid ${owner.pid} was ${status.reason}).`,
    };
  }

  log.info("lifecycle:stop_remote_owner", { pid: owner.pid, appId: owner.appId });
  terminatePid(owner.pid, false);

  const waitMs = options.waitMs ?? 4000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(owner.pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (isPidAlive(owner.pid)) {
    terminatePid(owner.pid, true);
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!isPidAlive(owner.pid)) {
    removeLockDir();
    return { stopped: true, detail: `Terminated qqbridge pid ${owner.pid} and released lock.` };
  }

  return {
    stopped: false,
    detail: `Failed to terminate pid ${owner.pid}. Try Task Manager or: taskkill /PID ${owner.pid} /T /F`,
  };
}
