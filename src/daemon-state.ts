import fs from "node:fs";
import path from "node:path";
import type { ProcessSystemStats } from "./process-system.ts";

const STATE_FILE_NAME = "daemon-state.json";

export type DaemonState = {
  /** Daemon process pid. */
  daemon: number;
  /** Managed process table snapshot. */
  processes: ProcessSystemStats["processes"];
  /** ISO timestamp of last write. */
  updatedAt: string;
};

export const stateFilePath = (projectRoot: string): string =>
  path.join(projectRoot, ".pi", "busytown", STATE_FILE_NAME);

/** Write daemon state atomically (tmp file + rename). */
export const writeDaemonState = (
  projectRoot: string,
  state: DaemonState,
): void => {
  const p = stateFilePath(projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  fs.renameSync(tmp, p);
};

/** Remove the state file if it exists. */
export const removeDaemonState = (projectRoot: string): void => {
  try {
    fs.unlinkSync(stateFilePath(projectRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
};

/** Read the state file. Returns undefined on ENOENT or parse failure. */
export const readDaemonState = (
  projectRoot: string,
): DaemonState | undefined => {
  let content: string;
  try {
    content = fs.readFileSync(stateFilePath(projectRoot), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(content) as DaemonState;
  } catch {
    return undefined;
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
 * Check if the daemon is running. Handles stale state files: if the file
 * exists but its recorded pid is dead, delete the stale file.
 */
export const getDaemonStatus = (projectRoot: string): DaemonStatus => {
  const state = readDaemonState(projectRoot);
  if (state === undefined) return { running: false };

  if (isProcessAlive(state.daemon)) return { running: true, pid: state.daemon };

  removeDaemonState(projectRoot);
  return { running: false };
};
