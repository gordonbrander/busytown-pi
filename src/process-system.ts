import type { ChildProcess } from "node:child_process";
import { loggerOf } from "./lib/json-logger.ts";

const logger = loggerOf({ source: "process-system.ts" });

/**
 * Kills a process with a timeout. First sends SIGTERM, then SIGKILL if it doesn't exit.
 * @param process The process to kill
 * @param timeout The timeout in milliseconds (default: 5000)
 * @returns A promise that resolves with the process exit code
 */
const killWithTimeout = (
  process: ChildProcess,
  timeout: number = 5000,
): Promise<number | null> => {
  if (process.exitCode !== null) return Promise.resolve(process.exitCode);
  return new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
    }, timeout);
    timer.unref();
    process.once("exit", () => {
      clearTimeout(timer);
      resolve(process.exitCode);
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
  /** Get stats for all managed processes. */
  stats: () => ProcessSystemStats;
  /** Dispose of the process system, killing all managed processes. */
  dispose: () => Promise<void>;
  /** Dispose of the process system, killing all managed processes. */
  [Symbol.asyncDispose]: () => Promise<void>;
};

const MAX_RESTARTS = 3;
const STABILITY_WINDOW_MS = 30_000;

export const processSystemOf = (): ProcessSystem => {
  const processes = new Map<string, ManagedProcess>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const attach = (managed: ManagedProcess): void => {
    managed.process.on("exit", (code) => {
      if (managed.state === "stopped") return;

      // Reset restart count if the process was stable
      const uptime = Date.now() - managed.lastSpawnTime;
      if (uptime >= STABILITY_WINDOW_MS) {
        managed.restartCount = 0;
      }

      if (code !== 0 && managed.restartCount < MAX_RESTARTS) {
        const delay = Math.pow(2, managed.restartCount) * 1000;
        logger.info("Restarting process", {
          id: managed.id,
          restartCount: managed.restartCount + 1,
          delayMs: delay,
        });
        const timer = setTimeout(() => {
          timers.delete(timer);
          managed.restartCount++;
          managed.lastSpawnTime = Date.now();
          managed.process = managed.factory(managed.id);
          attach(managed);
        }, delay);
        timers.add(timer);
      } else if (code !== 0) {
        managed.state = "crashed";
        logger.error("Process crashed after max restarts", {
          id: managed.id,
          restartCount: managed.restartCount,
        });
      } else {
        managed.state = "stopped";
        logger.debug("Process exited cleanly", { id: managed.id });
      }
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
    };
    attach(managed);
    processes.set(id, managed);
  };

  const kill = async (id: string): Promise<void> => {
    const managed = processes.get(id);
    if (!managed) return;
    managed.state = "stopped";
    const exitCode = await killWithTimeout(managed.process);
    processes.delete(id);
    logger.debug("Killed process", { id, exitCode });
  };

  const stats = (): ProcessSystemStats => ({
    processes: Array.from(processes.values()).map((m) => ({
      id: m.id,
      state: m.state,
      restartCount: m.restartCount,
      pid: m.process.pid,
    })),
  });

  const dispose = async (): Promise<void> => {
    logger.debug("Disposing process system");
    // Clear pending restart timers
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();

    /** Kill processes in parallel */
    const exitPromises = Array.from(processes.values()).map(async (m) => {
      m.state = "stopped";
      await killWithTimeout(m.process);
    });

    await Promise.allSettled(exitPromises);

    processes.clear();
    logger.debug("Disposed process system");
  };

  return {
    spawn,
    kill,
    stats,
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
};
