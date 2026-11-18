import { execFileSync } from "node:child_process";

/** True if a process with this PID exists (EPERM counts as alive). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false; // ESRCH and others → not alive
  }
}

export function getProcessCommandLine(pid: number): string | undefined {
  if (process.platform !== "win32") {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "args="], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      }).trim();
    } catch {
      return undefined;
    }
  }

  try {
    // Prefer CIM over deprecated wmic; args are separate (no shell concat).
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue;`,
      `if ($p) { $p.CommandLine }`,
    ].join(" ");
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    ).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export function getProcessStartTimeMs(pid: number): number | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  try {
    const script = [
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;`,
      `if ($p) { [DateTimeOffset]::new($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() }`,
    ].join(" ");
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    ).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Heuristic: command line belongs to qq-cli-bridge / qqbridge CLI. */
export function looksLikeQqbridgeProcess(commandLine: string | undefined): boolean {
  if (!commandLine) return false;
  const s = commandLine.toLowerCase();
  return (
    s.includes("qq-cli-bridge") ||
    s.includes("qqbridge") ||
    /dist[/\\]cli\.js/.test(s) ||
    /src[/\\]cli\.ts/.test(s)
  );
}

/**
 * Decide whether an existing lock owner is still active.
 * Stale ONLY when the PID is gone, or the PID was clearly recycled
 * (process start time after the lock was written).
 * Never treat "alive but quiet / unknown cmdline" as stale.
 */
export function isLockOwnerActive(owner: {
  pid: number;
  startedAtMs: number;
}): { active: boolean; reason: string } {
  if (!isPidAlive(owner.pid)) {
    return { active: false, reason: "pid_not_alive" };
  }

  const startMs = getProcessStartTimeMs(owner.pid);
  // PID reuse: OS started a new process with the same PID after our lock.
  if (startMs !== undefined && startMs > owner.startedAtMs + 5000) {
    return { active: false, reason: "pid_start_after_lock" };
  }

  return { active: true, reason: "alive_pid" };
}

export function terminatePid(pid: number, force = false): boolean {
  if (!isPidAlive(pid) || pid === process.pid) return false;
  try {
    if (process.platform === "win32") {
      // taskkill is more reliable for process trees of node wrappers on Windows.
      execFileSync(
        "taskkill.exe",
        force ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"],
        { encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } else {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    }
    return true;
  } catch {
    try {
      process.kill(pid);
      return true;
    } catch {
      return false;
    }
  }
}
