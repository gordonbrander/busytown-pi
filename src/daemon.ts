import { spawn } from "node:child_process";
import path from "node:path";
import { getDaemonStatus, type DaemonStatus } from "./pidfile.ts";
import { sleep } from "./lib/promise.ts";

const resolveCliBin = (): string =>
  path.join(path.dirname(new URL(import.meta.url).pathname), "cli.ts");

/**
 * Spawn the busytown daemon as a detached process.
 * Returns true if the daemon started successfully, false otherwise.
 */
export const spawnDaemon = async (
  projectRoot: string,
): Promise<{ ok: boolean; pid?: number }> => {
  const status = getDaemonStatus(projectRoot);
  if (status.running) return { ok: true, pid: status.pid };

  const cliBin = resolveCliBin();
  const logPath = path.join(projectRoot, ".busytown", "daemon.log");

  const child = spawn(
    "node",
    [
      "--experimental-strip-types",
      cliBin,
      "start",
      "--dir",
      projectRoot,
      "--log",
      logPath,
    ],
    {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
    },
  );

  child.unref();

  // Poll pidfile for up to ~2s to confirm it started
  for (let i = 0; i < 10; i++) {
    await sleep(200);
    const check = getDaemonStatus(projectRoot);
    if (check.running) return { ok: true, pid: check.pid };
  }

  return { ok: false };
};

/**
 * Stop the busytown daemon by sending SIGTERM.
 * Returns true if the daemon was stopped (or wasn't running).
 */
export const stopDaemon = async (
  projectRoot: string,
): Promise<{ ok: boolean; wasRunning: boolean }> => {
  const status = getDaemonStatus(projectRoot);
  if (!status.running) return { ok: true, wasRunning: false };

  process.kill(status.pid!, "SIGTERM");

  // Poll for process exit (up to ~5s)
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    const check = getDaemonStatus(projectRoot);
    if (!check.running) return { ok: true, wasRunning: true };
  }

  return { ok: false, wasRunning: true };
};

export { getDaemonStatus, type DaemonStatus };
