#!/usr/bin/env -S node --experimental-strip-types

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineCommand, runMain } from "citty";
import {
  claimEvent,
  compactEvents,
  getClaimant,
  getEventsSince,
  getOrOpenDb,
  pushEvent,
  seekToTail,
} from "./event-queue.ts";
import { listAgentPaths } from "./agents/file-agent-loader.ts";
import {
  processSystemOf,
  type ProcessFactory,
  type ProcessSystemStats,
} from "./process-system.ts";
import { clientOf } from "./sdk.ts";
import { watchFiles } from "./file-watcher.ts";
import { forever } from "./lib/promise.ts";
import {
  getDaemonStatus,
  writeDaemonState,
  removeDaemonState,
  readDaemonState,
  isProcessAlive,
} from "./daemon-state.ts";
import { loggerOf } from "./lib/json-logger.ts";
import { cleanupGroupAsync } from "./lib/cleanup.ts";
import { unwrap, toOption } from "./lib/option.ts";
import { pathToSlug } from "./lib/slug.ts";

const logger = loggerOf({ source: "cli.ts" });

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE_AGENT_SCRIPT = path.join(MODULE_DIR, "agents", "file-agent.ts");

// -- Shared arg definitions --------------------------------------------------

const globalArgs = {
  dir: {
    type: "string" as const,
    alias: "d",
    description: "Project root directory (default: cwd)",
  },
  db: {
    type: "string" as const,
    description:
      "Path to SQLite database (default: <dir>/.pi/busytown/events.db)",
  },
};

// -- Helpers -----------------------------------------------------------------

const resolveDbPath = (dir?: string, db?: string): string => {
  if (db) return db;
  const root = dir ?? process.cwd();
  return path.join(root, ".pi", "busytown", "events.db");
};

const resolveAgentsDir = (dir?: string, agentsDir?: string): string => {
  if (agentsDir) return agentsDir;
  const root = dir ?? process.cwd();
  return path.join(root, ".pi", "agents");
};

const resolveProjectRoot = (dir?: string): string => dir ?? process.cwd();

const resolveDb = (dir?: string, db?: string) =>
  getOrOpenDb(resolveDbPath(dir, db));

/** Create a ProcessFactory that spawns a file-agent for the given agent def. */
const fileAgentFactory =
  (
    agentDefPath: string,
    dbPath: string,
    cwd: string,
    pollInterval = 1000,
  ): ProcessFactory =>
  (_id: string) =>
    spawn(
      "node",
      [
        "--experimental-strip-types",
        FILE_AGENT_SCRIPT,
        "--agent",
        agentDefPath,
        "--db",
        dbPath,
        "--poll",
        String(pollInterval),
        "--parent-pid",
        String(process.pid),
      ],
      {
        cwd,
        stdio: "inherit",
      },
    );

// -- Subcommands -------------------------------------------------------------

const startCommand = defineCommand({
  meta: {
    name: "start",
    description: "Start the agent system (long-running daemon)",
  },
  args: {
    ...globalArgs,
    "agents-dir": {
      type: "string",
      description: "Agent definitions directory (default: <dir>/.pi/agents)",
    },
    log: {
      type: "string",
      description:
        "Path to log file for stdout/stderr (default: log to stdout)",
    },
  },
  run: async ({ args }) => {
    const cleanupEverything = cleanupGroupAsync();

    const projectRoot = resolveProjectRoot(args.dir);
    const agentsDir = resolveAgentsDir(args.dir, args["agents-dir"]);

    // Check for existing daemon
    const status = getDaemonStatus(projectRoot);
    if (status.running) {
      logger.error(
        `Busytown daemon already running. Use 'busytown stop' first.`,
        { pid: status.pid },
      );
      process.exit(1);
    }

    if (args.log) {
      const logPath = path.resolve(args.log);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const logFd = fs.openSync(logPath, "a");
      const logStream = fs.createWriteStream("", { fd: logFd });
      process.stdout.write = logStream.write.bind(
        logStream,
      ) as typeof process.stdout.write;
      process.stderr.write = logStream.write.bind(
        logStream,
      ) as typeof process.stderr.write;
    }

    const writeState = (
      processes: ProcessSystemStats["processes"] = [],
    ): void =>
      writeDaemonState(projectRoot, {
        daemon: process.pid,
        processes,
        updatedAt: new Date().toISOString(),
        agentsDir,
      });

    // Write initial state file — this also serves as the daemon's liveness
    // marker, so write it before spawning any agents.
    writeState();
    cleanupEverything.add(() => removeDaemonState(projectRoot));

    const db = resolveDb(args.dir, args.db);
    cleanupEverything.add(() => db.close());

    const dbPath = unwrap(toOption(db.location()), "No database location");

    const system = processSystemOf({
      onStatsChange: (s) => writeState(s.processes),
    });

    cleanupEverything.add(async () => {
      await system.killAll();
    });

    const reloadSystem = async (): Promise<void> => {
      try {
        logger.info("Agent system reloading...", { stats: system.stats() });
        await system.killAll();
        for await (const agentPath of listAgentPaths(agentsDir)) {
          try {
            const factory = fileAgentFactory(agentPath, dbPath, projectRoot);
            // Use filename (without extension) as process id
            const id = unwrap(
              pathToSlug(agentPath),
              `Unable to generate slug from agent path: ${agentPath}`,
            );
            system.spawn(id, factory);
          } catch (e) {
            logger.error("Failed to spawn agent", {
              path: agentPath,
              error: `${e}`,
            });
          }
        }
        logger.info("Agent system reloaded", { stats: system.stats() });
      } catch (e) {
        logger.error("Agent system reload failed", { error: `${e}` });
      }
    };

    // Reload handler: uses SDK directly to listen for sys.reload events
    const reloadClient = clientOf({ id: "_sys-reload", dbPath });
    const reloadAbort = new AbortController();
    cleanupEverything.add(() => reloadAbort.abort());

    const runReloadLoop = async (): Promise<void> => {
      for await (const _event of reloadClient.subscribe({
        listen: ["sys.reload"],
        pollInterval: 1000,
        signal: reloadAbort.signal,
      })) {
        await reloadSystem();
      }
    };
    runReloadLoop().catch((e) => {
      logger.error("Reload loop crashed; shutting down daemon", {
        error: `${e}`,
      });
      process.exit(1);
    });

    const stopFileWatcher = watchFiles(db, projectRoot);
    cleanupEverything.add(stopFileWatcher);

    pushEvent(db, "sys", "sys.daemon.start");
    logger.info("Daemon start", {
      pid: process.pid,
      db: db.location(),
      agents_dir: agentsDir,
    });

    await reloadSystem();

    const shutdown = async () => {
      logger.info("Shutting down daemon", { pid: process.pid });
      pushEvent(db, "sys", "sys.daemon.finish");
      await cleanupEverything();
      process.exit(0);
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    await forever();
  },
});

const stopCommand = defineCommand({
  meta: {
    name: "stop",
    description: "Stop the running Busytown daemon",
  },
  args: {
    ...globalArgs,
  },
  run: async ({ args }) => {
    const projectRoot = resolveProjectRoot(args.dir);
    const status = getDaemonStatus(projectRoot);

    if (!status.running) {
      console.log("Busytown daemon is not running.");
      return;
    }

    console.log(`Sending SIGTERM to daemon (pid ${status.pid})...`);
    process.kill(status.pid!, "SIGTERM");

    // Poll for process exit (up to ~5s)
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      if (!isProcessAlive(status.pid!)) {
        removeDaemonState(projectRoot);
        console.log("Busytown daemon stopped.");
        return;
      }
    }

    console.error(
      `Daemon (pid ${status.pid}) did not exit within 5s. You may need to kill it manually.`,
    );
    process.exit(1);
  },
});

const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Check if the Busytown daemon is running",
  },
  args: {
    ...globalArgs,
  },
  run: ({ args }) => {
    const projectRoot = resolveProjectRoot(args.dir);
    const status = getDaemonStatus(projectRoot);

    if (!status.running) {
      console.log("Busytown daemon is not running.");
      return;
    }

    console.log(`Busytown daemon is running (pid ${status.pid}).`);
  },
});

const readPayload = (args: { payload?: string; msg?: string }) => {
  if (args.payload) {
    return JSON.parse(args.payload);
  }
  if (args.msg) {
    return { msg: args.msg };
  }
  return {};
};

const pushCommand = defineCommand({
  meta: { name: "push", description: "Push an event to the queue" },
  args: {
    ...globalArgs,
    agent: {
      alias: "a",
      type: "string",
      description: "Agent ID",
      required: true,
    },
    type: {
      type: "string",
      alias: "t",
      description: "Event type",
      required: true,
    },
    payload: {
      type: "string",
      alias: "p",
      description: "Event payload as JSON (default: {})",
    },
    msg: {
      type: "string",
      alias: "m",
      description: 'Shorthand for --payload \'{"msg":"..."}\'',
    },
  },
  run: ({ args }) => {
    const db = resolveDb(args.dir, args.db);
    try {
      const payload = readPayload(args);
      const event = pushEvent(db, args.agent, args.type, payload);
      console.log(JSON.stringify(event));
    } finally {
      db.close();
    }
  },
});

const eventsCommand = defineCommand({
  meta: { name: "events", description: "List recent events" },
  args: {
    ...globalArgs,
    tail: {
      type: "string",
      description: "Number of recent events to show (default: 20)",
    },
    type: {
      type: "string",
      description: "Filter by event type",
    },
  },
  run: ({ args }) => {
    const db = resolveDb(args.dir, args.db);
    try {
      const tail = args.tail ? parseInt(args.tail, 10) : 20;
      const events = getEventsSince(db, {
        tail: isNaN(tail) ? 20 : tail,
        filterType: args.type,
      });
      if (events.length === 0) {
        console.error("No events found.");
        return;
      }
      for (const event of events) {
        console.log(JSON.stringify(event));
      }
    } finally {
      db.close();
    }
  },
});

const claimCommand = defineCommand({
  meta: { name: "claim", description: "Claim an event" },
  args: {
    ...globalArgs,
    agent: {
      type: "string",
      description: "Agent ID",
      required: true,
    },
    event: {
      type: "string",
      description: "Event ID",
      required: true,
    },
  },
  run: ({ args }) => {
    const db = resolveDb(args.dir, args.db);
    try {
      const claimed = claimEvent(db, args.agent, parseInt(args.event, 10));
      const claimant = getClaimant(db, parseInt(args.event, 10));
      console.log(JSON.stringify({ claimed, claimant }));
    } finally {
      db.close();
    }
  },
});

const checkClaimCommand = defineCommand({
  meta: { name: "check-claim", description: "Check who claimed an event" },
  args: {
    ...globalArgs,
    event: {
      type: "string",
      description: "Event ID",
      required: true,
    },
  },
  run: ({ args }) => {
    const db = resolveDb(args.dir, args.db);
    try {
      const claimant = getClaimant(db, parseInt(args.event, 10));
      console.log(JSON.stringify({ claimant: claimant ?? null }));
    } finally {
      db.close();
    }
  },
});

const statsCommand = defineCommand({
  meta: {
    name: "stats",
    description: "Show daemon and agent process stats",
  },
  args: {
    ...globalArgs,
  },
  run: ({ args }) => {
    const projectRoot = resolveProjectRoot(args.dir);
    const status = getDaemonStatus(projectRoot);
    if (!status.running) {
      console.log(JSON.stringify({ running: false }));
      return;
    }
    const state = readDaemonState(projectRoot);
    console.log(JSON.stringify({ running: true, ...state }));
  },
});

const reloadCommand = defineCommand({
  meta: {
    name: "reload",
    description: "Reload agent definitions (sends sys.reload event)",
  },
  args: {
    ...globalArgs,
  },
  run: ({ args }) => {
    const db = resolveDb(args.dir, args.db);
    try {
      const event = pushEvent(db, "sys", "sys.reload");
      console.log(JSON.stringify(event));
    } finally {
      db.close();
    }
  },
});

const epochCommand = defineCommand({
  meta: {
    name: "epoch",
    description:
      "Push a sys.epoch event and advance all agent cursors to its id",
  },
  args: {
    ...globalArgs,
  },
  run: ({ args }) => {
    const db = resolveDb(args.dir, args.db);
    try {
      const result = seekToTail(db);
      console.log(JSON.stringify(result));
    } finally {
      db.close();
    }
  },
});

const compactDbCommand = defineCommand({
  meta: {
    name: "compact-db",
    description: "Delete events already processed by all agents",
  },
  args: {
    ...globalArgs,
    "warn-threshold": {
      type: "string",
      description: "Warn for agents more than N events behind (default: 100)",
    },
  },
  run: ({ args }) => {
    const db = resolveDb(args.dir, args.db);
    try {
      const raw = args["warn-threshold"];
      const parsed = raw ? parseInt(raw, 10) : 100;
      const threshold = isNaN(parsed) ? 100 : parsed;
      const result = compactEvents(db, threshold);
      for (const { agent_id, behind } of result.laggingAgents) {
        console.warn(`warning: agent "${agent_id}" is ${behind} events behind`);
      }
      console.log(JSON.stringify(result));
    } finally {
      db.close();
    }
  },
});

// -- Main command ------------------------------------------------------------

const main = defineCommand({
  meta: {
    name: "busytown",
    version: "0.1.0",
    description: "Busytown event queue CLI",
  },
  subCommands: {
    start: startCommand,
    stop: stopCommand,
    status: statusCommand,
    stats: statsCommand,
    push: pushCommand,
    events: eventsCommand,
    claim: claimCommand,
    "check-claim": checkClaimCommand,
    reload: reloadCommand,
    epoch: epochCommand,
    "compact-db": compactDbCommand,
  },
});

runMain(main);
