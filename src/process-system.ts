import type { ChildProcess } from "node:child_process";
import { cleanupGroupAsync, type CleanupGroupAsync } from "./lib/cleanup.ts";
import { loggerOf } from "./lib/json-logger.ts";

const logger = loggerOf({ source: "process-system.ts" });

export type KillReceipt = {
  signal: string | undefined;
  exitCode: number | undefined;
};

/**
 * Kills a process with a timeout. First sends SIGTERM, then SIGKILL if it doesn't exit.
 * @param process The process to kill
 * @param timeout The timeout in milliseconds (default: 5000)
 * @returns A promise that resolves to a KillReceipt object containing the signal and exit code
 */
export const killWithTimeout = (
  process: ChildProcess,
  timeout: number = 5000,
): Promise<KillReceipt> => {
  if (process.exitCode !== null)
    return Promise.resolve({
      signal: process.signalCode ?? undefined,
      exitCode: process.exitCode ?? undefined,
    });
  return new Promise<KillReceipt>((resolve) => {
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
    }, timeout);
    timer.unref();
    process.once("exit", () => {
      clearTimeout(timer);
      resolve({
        signal: process.signalCode ?? undefined,
        exitCode: process.exitCode ?? undefined,
      });
    });
    process.kill("SIGTERM");
  });
};

/** Factory that creates a child process. Called on initial spawn and on restart. */
export type ProcessFactory = (id: string) => ChildProcess;

export type ManagedProcess = {
  id: string;
  factory: ProcessFactory;
  process: ChildProcess;
  restartCount: number;
  state: "running" | "stopped" | "crashed";
  /** Timestamp of last spawn, used for stability window. */
  lastSpawnTime: number;
  /** Teardown for the current process instance (e.g. exit listener). */
  cleanup: CleanupGroupAsync;
};

export type ProcessSystemStats = {
  processes: Array<{
    id: string;
    state: ManagedProcess["state"];
    restartCount: number;
    pid: number | undefined;
  }>;
};

export type ProcessSystem = {
  /** Spawn a managed process. The factory is stored for restarts. */
  spawn: (id: string, factory: ProcessFactory) => void;
  /** Kill a managed process by id (SIGTERM). */
  kill: (id: string) => Promise<void>;
  /** Kill all managed processes. */
  killAll: () => Promise<void>;
  /** Get stats for all managed processes. */
  stats: () => ProcessSystemStats;
};

export type ProcessSystemOptions = {
  /** Base delay for exponential restart backoff, in ms. Default: 10_000. */
  restartBaseDelayMs?: number;
  /** Max restart attempts before marking a process crashed. Default: 3. */
  maxRestarts?: number;
  /** Uptime required to reset the restart counter, in ms. Default: 30_000. */
  stabilityWindowMs?: number;
  /** Called whenever the process table changes (spawn, kill, restart, crash). */
  onStatsChange?: (stats: ProcessSystemStats) => void;
};

export const processSystemOf = (
  options: ProcessSystemOptions = {},
): ProcessSystem => {
  const restartBaseDelayMs = options.restartBaseDelayMs ?? 10_000;
  const maxRestarts = options.maxRestarts ?? 3;
  const stabilityWindowMs = options.stabilityWindowMs ?? 30_000;

  const processes = new Map<string, ManagedProcess>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const stats = (): ProcessSystemStats => ({
    processes: Array.from(processes.values()).map((m) => ({
      id: m.id,
      state: m.state,
      restartCount: m.restartCount,
      pid: m.process.pid,
    })),
  });

  const notifyStatsChange = (): void => {
    options.onStatsChange?.(stats());
  };

  const attach = (managed: ManagedProcess): void => {
    const proc = managed.process;
    const onExit = (code: number | null) => {
      // Reset restart count if the process was stable
      const uptime = Date.now() - managed.lastSpawnTime;
      if (uptime >= stabilityWindowMs) {
        managed.restartCount = 0;
      }

      // `code === null` means killed by signal (OOM, SIGSEGV, external
      // SIGKILL) and `null !== 0` is true, so signal deaths take the restart
      // path. Intentional kills don't reach here — `kill()` detaches this
      // listener before signalling the process.
      if (code !== 0 && managed.restartCount < maxRestarts) {
        const delay = Math.pow(2, managed.restartCount) * restartBaseDelayMs;
        logger.info("Restarting process", {
          id: managed.id,
          restartCount: managed.restartCount + 1,
          delayMs: delay,
        });
        const timer = setTimeout(async () => {
          timers.delete(timer);
          // Drain the stale detach entry from the previous process instance
          // before binding a fresh listener for the new one.
          await managed.cleanup();
          managed.restartCount++;
          managed.lastSpawnTime = Date.now();
          managed.process = managed.factory(managed.id);
          attach(managed);
          notifyStatsChange();
        }, delay);
        timers.add(timer);
      } else if (code !== 0) {
        managed.state = "crashed";
        logger.error("Process crashed after max restarts", {
          id: managed.id,
          restartCount: managed.restartCount,
        });
        notifyStatsChange();
      } else {
        managed.state = "stopped";
        logger.debug("Process exited cleanly", { id: managed.id });
        notifyStatsChange();
      }
    };
    proc.once("exit", onExit);
    managed.cleanup.add(() => {
      proc.off("exit", onExit);
    });
  };

  const spawn = (id: string, factory: ProcessFactory): void => {
    if (processes.has(id)) {
      throw new Error(`Process with id "${id}" already exists`);
    }
    logger.debug("Spawning process", { id });
    const managed: ManagedProcess = {
      id,
      factory,
      process: factory(id),
      restartCount: 0,
      state: "running",
      lastSpawnTime: Date.now(),
      cleanup: cleanupGroupAsync(),
    };
    attach(managed);
    processes.set(id, managed);
    notifyStatsChange();
  };

  const kill = async (id: string): Promise<void> => {
    const managed = processes.get(id);
    if (!managed) return;
    managed.state = "stopped";
    // Detach the restart listener before killing so an escalated SIGKILL
    // (code === null) can't be misread as a crash and respawned.
    await managed.cleanup();
    const exitCode = await killWithTimeout(managed.process);
    processes.delete(id);
    logger.debug("Killed process", { id, exitCode });
    notifyStatsChange();
  };

  const killAll = async (): Promise<void> => {
    const processIds = Array.from(processes.keys());
    logger.debug("Killing all processes", {
      processIds,
    });
    // Clear pending restart timers
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();

    /** Kill processes in parallel */
    const exitPromises = Array.from(processes.values()).map(async (m) => {
      m.state = "stopped";
      await m.cleanup();
      await killWithTimeout(m.process);
    });

    await Promise.allSettled(exitPromises);

    processes.clear();
    logger.debug("Killed all processes", {
      processIds,
    });
    notifyStatsChange();
  };

  return {
    spawn,
    kill,
    killAll,
    stats,
  };
};
