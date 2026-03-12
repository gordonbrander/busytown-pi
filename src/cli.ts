#!/usr/bin/env -S node --experimental-strip-types

import fs from "node:fs";
import path from "node:path";
import { defineCommand, runMain } from "citty";
import {
  claimEvent,
  getClaimant,
  getEventsSince,
  getOrOpenDb,
  pushEvent,
} from "./event-queue.ts";
import { loadAllAgents, updateAgentFrontmatter } from "./agent.ts";
import { applyMemoryUpdate } from "./memory.ts";
import { createSystem, worker } from "./worker.ts";
import { makeAgentWorker } from "./pi-process.ts";
import { watchFiles } from "./file-watcher.ts";
import { forever } from "./lib/promise.ts";
import {
  getDaemonStatus,
  writePidfile,
  removePidfile,
  isProcessAlive,
} from "./pidfile.ts";
import { logger } from "./lib/json-logger.ts";

// -- Shared arg definitions --------------------------------------------------

const globalArgs = {
  dir: {
    type: "string" as const,
    alias: "d",
    description: "Project root directory (default: cwd)",
  },
  db: {
    type: "string" as const,
    description: "Path to SQLite database (default: <dir>/.busytown/events.db)",
  },
};

// -- Helpers -----------------------------------------------------------------

const resolveDbPath = (dir?: string, db?: string): string => {
  if (db) return db;
  const root = dir ?? process.cwd();
  return path.join(root, ".busytown", "events.db");
};

const resolveAgentsDir = (dir?: string, agentsDir?: string): string => {
  if (agentsDir) return agentsDir;
  const root = dir ?? process.cwd();
  return path.join(root, ".pi", "agents");
};

const resolveProjectRoot = (dir?: string): string => dir ?? process.cwd();

const resolveDb = (dir?: string, db?: string) =>
  getOrOpenDb(resolveDbPath(dir, db));

// -- Subcommands -------------------------------------------------------------

const startCommand = defineCommand({
  meta: {
    name: "start",
    description: "Start the worker system (long-running daemon)",
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
    const projectRoot = resolveProjectRoot(args.dir);
    const agentsDir = resolveAgentsDir(args.dir, args["agents-dir"]);

    // Check for existing daemon
    const status = getDaemonStatus(projectRoot);
    if (status.running) {
      console.error(
        `Busytown daemon already running (pid ${status.pid}). Use 'busytown stop' first.`,
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

    // Write pidfile
    writePidfile(projectRoot);

    const db = resolveDb(args.dir, args.db);
    const system = createSystem(db);

    const spawnAll = (): number => {
      const agents = loadAllAgents(agentsDir);
      const toWorker = makeAgentWorker(db, projectRoot);
      let spawned = 0;

      for (const agent of agents) {
        if (agent.listen.length === 0) continue;
        try {
          system.spawn(toWorker(agent));
          spawned++;
          logger.info("Agent spawned", {
            agent: agent.id,
            listen: agent.listen,
          });
        } catch (err) {
          logger.error("Agent spawn failed", {
            agent: agent.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const reload = async () => {
        await system.stop();
        const count = spawnAll();
        logger.info("Agents reloaded", { count });
      };

      system.spawn(
        worker({
          id: "_sys_reload",
          listen: ["sys.reload"],
          hidden: true,
          ignoreSelf: true,
          run: async () => {
            void reload();
          },
        }),
      );

      return spawned;
    };

    const spawned = spawnAll();
    const stopFileWatcher = watchFiles(db, projectRoot);

    pushEvent(db, "sys", "sys.lifecycle.start");
    logger.info("Busytown daemon started", {
      pid: process.pid,
      agents: spawned,
      db: db.location(),
      agents_dir: agentsDir,
    });

    const shutdown = async () => {
      logger.info("Shutting down");
      pushEvent(db, "sys", "sys.lifecycle.finish");
      removePidfile(projectRoot);
      await stopFileWatcher();
      await system.stop();
      db.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

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
        removePidfile(projectRoot);
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

    // Show some info from the DB
    try {
      const db = resolveDb(args.dir, args.db);
      const tip = getEventsSince(db, { tail: 1 });
      if (tip.length > 0) {
        console.log(`  last event: #${tip[0]!.id} (${tip[0]!.type})`);
      }
      const agentsDir = resolveAgentsDir(args.dir);
      const agents = loadAllAgents(agentsDir);
      const listening = agents.filter((a) => a.listen.length > 0);
      console.log(`  agents:     ${listening.length} listening`);
      db.close();
    } catch {
      // DB might not exist yet, that's fine
    }
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
    worker: {
      alias: "w",
      type: "string",
      description: "Worker ID",
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
      const event = pushEvent(db, args.worker, args.type, payload);
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

const agentsCommand = defineCommand({
  meta: { name: "agents", description: "List loaded agent definitions" },
  args: {
    ...globalArgs,
    "agents-dir": {
      type: "string",
      description: "Agent definitions directory (default: <dir>/.pi/agents)",
    },
  },
  run: ({ args }) => {
    const agentsDir = resolveAgentsDir(args.dir, args["agents-dir"]);
    const agents = loadAllAgents(agentsDir);
    if (agents.length === 0) {
      console.log(`No agents found in ${agentsDir}`);
      return;
    }
    for (const agent of agents) {
      const listen =
        agent.listen.length > 0 ? agent.listen.join(", ") : "(none)";
      const emits = agent.emits.length > 0 ? agent.emits.join(", ") : "(none)";
      console.log(`${agent.id} (${agent.type})`);
      if (agent.description) console.log(`  ${agent.description}`);
      console.log(`  listen: ${listen}`);
      console.log(`  emits:  ${emits}`);
      console.log();
    }
  },
});

const claimCommand = defineCommand({
  meta: { name: "claim", description: "Claim an event" },
  args: {
    ...globalArgs,
    worker: {
      type: "string",
      description: "Worker ID",
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
      const claimed = claimEvent(db, args.worker, parseInt(args.event, 10));
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

const updateMemoryCommand = defineCommand({
  meta: {
    name: "update-memory",
    description: "Update a memory block in an agent file",
  },
  args: {
    ...globalArgs,
    "agents-dir": {
      type: "string",
      description: "Agent definitions directory (default: <dir>/.pi/agents)",
    },
    agent: {
      type: "string",
      description: "Agent ID (matches filename or name field)",
      required: true,
    },
    block: {
      type: "string",
      description: "Memory block key",
      required: true,
    },
    "new-text": {
      type: "string",
      description: "New text (replacement or append)",
      required: true,
    },
    "old-text": {
      type: "string",
      description: "Text to find and replace (omit to append)",
    },
  },
  run: ({ args }) => {
    const agentsDir = resolveAgentsDir(args.dir, args["agents-dir"]);
    const agents = loadAllAgents(agentsDir);
    const agent = agents.find((a) => a.id === args.agent);
    if (!agent) {
      console.error(`Agent "${args.agent}" not found in ${agentsDir}`);
      process.exit(1);
    }

    const block = agent.memoryBlocks[args.block];
    if (!block) {
      const available = Object.keys(agent.memoryBlocks).join(", ");
      console.error(
        `Block "${args.block}" not found. Available: ${available || "(none)"}`,
      );
      process.exit(1);
    }

    const result = applyMemoryUpdate(
      block.value,
      block.charLimit,
      args["new-text"],
      args["old-text"],
    );

    updateAgentFrontmatter(agent.filePath, (frontmatter) => {
      const mb = frontmatter.memory_blocks ?? {};
      if (mb[args.block]) {
        mb[args.block].value = result.text;
      }
      return { ...frontmatter, memory_blocks: mb };
    });

    console.log(
      JSON.stringify({
        blockKey: args.block,
        usage: `${result.text.length}/${block.charLimit}`,
        truncated: result.truncated,
        value: result.text,
      }),
    );
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
    push: pushCommand,
    events: eventsCommand,
    agents: agentsCommand,
    claim: claimCommand,
    "check-claim": checkClaimCommand,
    "update-memory": updateMemoryCommand,
    reload: reloadCommand,
  },
});

runMain(main);
