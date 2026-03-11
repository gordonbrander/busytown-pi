import fs from "node:fs";
import path from "node:path";

const PIDFILE_NAME = "busytown.pid";

export const pidfilePath = (projectRoot: string): string =>
  path.join(projectRoot, ".busytown", PIDFILE_NAME);

/** Write current process PID to the pidfile. Creates .busytown dir if needed. */
export const writePidfile = (projectRoot: string): void => {
  const p = pidfilePath(projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${process.pid}\n`);
};

/** Remove the pidfile if it exists. */
export const removePidfile = (projectRoot: string): void => {
  try {
    fs.unlinkSync(pidfilePath(projectRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
};

/** Read the PID from the pidfile. Returns undefined if file doesn't exist. */
export const readPidfile = (projectRoot: string): number | undefined => {
  try {
    const content = fs.readFileSync(pidfilePath(projectRoot), "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? undefined : pid;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
};

/** Check if a process with the given PID is alive (signal 0 = existence check). */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export type DaemonStatus = {
  running: boolean;
  pid?: number;
};

/**
 * Check if the daemon is running. Handles stale pidfiles:
 * if the pidfile exists but the process is dead, delete the stale pidfile.
 */
export const getDaemonStatus = (projectRoot: string): DaemonStatus => {
  const pid = readPidfile(projectRoot);
  if (pid === undefined) return { running: false };

  if (isProcessAlive(pid)) return { running: true, pid };

  // Stale pidfile — process is gone
  removePidfile(projectRoot);
  return { running: false };
};
