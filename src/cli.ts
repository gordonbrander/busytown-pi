#!/usr/bin/env node

import path from "node:path"
import fs from "node:fs"
import type { DatabaseSync } from "node:sqlite"
import { defineCommand, runMain, type CommandContext, type ArgsDef } from "citty"
import {
  openDb,
  pushEvent,
  claimEvent,
  getClaimant,
  getEventsSince,
} from "./event-queue.ts"
import { loadAllAgents } from "./agent.ts"
import { createSystem } from "./worker.ts"
import { makeAgentWorker } from "./pi-process.ts"
import { watchAgents } from "./agent-watcher.ts"
import { forever } from "./utils.ts"

// -- Shared arg definitions --------------------------------------------------

const globalArgs = {
  dir: {
    type: "string" as const,
    description: "Project root directory (default: cwd)",
  },
  db: {
    type: "string" as const,
    description: "Path to SQLite database (default: <dir>/.busytown/events.db)",
  },
}

// -- Helpers -----------------------------------------------------------------

const resolveDbPath = (dir?: string, db?: string): string => {
  if (db) return db
  const root = dir ?? process.cwd()
  return path.join(root, ".busytown", "events.db")
}

const resolveAgentsDir = (dir?: string, agentsDir?: string): string => {
  if (agentsDir) return agentsDir
  const root = dir ?? process.cwd()
  return path.join(root, ".pi", "agents")
}

const resolveProjectRoot = (dir?: string): string => dir ?? process.cwd()

const resolveCliBin = (): string =>
  path.join(path.dirname(new URL(import.meta.url).pathname), "cli.ts")

const ensureDb = (dir?: string, db?: string): { db: DatabaseSync; dbPath: string } => {
  const dbPath = resolveDbPath(dir, db)
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  return { db: openDb(dbPath), dbPath }
}

// -- Subcommands -------------------------------------------------------------

const startCommand = defineCommand({
  meta: { name: "start", description: "Start the worker system (long-running)" },
  args: {
    ...globalArgs,
    "agents-dir": {
      type: "string",
      description: "Agent definitions directory (default: <dir>/.pi/agents)",
    },
  },
  run: async ({ args }) => {
    const projectRoot = resolveProjectRoot(args.dir)
    const agentsDir = resolveAgentsDir(args.dir, args["agents-dir"])
    const cliBin = resolveCliBin()
    const { db, dbPath } = ensureDb(args.dir, args.db)

    const system = createSystem(db)

    const agents = loadAllAgents(agentsDir)
    const toWorker = makeAgentWorker(db, dbPath, projectRoot, cliBin)
    let spawned = 0

    for (const agent of agents) {
      if (agent.listen.length === 0) continue
      try {
        system.spawn(toWorker(agent))
        spawned++
        console.log(`  ✓ ${agent.id} listening for [${agent.listen.join(", ")}]`)
      } catch (err) {
        console.error(`  ✗ ${agent.id}: ${err instanceof Error ? err.message : err}`)
      }
    }

    const stopWatcher = watchAgents(agentsDir, system, db, dbPath, projectRoot, cliBin)

    pushEvent(db, "sys", "sys.lifecycle.start")
    console.log(`\nBusytown started (${spawned} agent${spawned === 1 ? "" : "s"})`)
    console.log(`  db:     ${dbPath}`)
    console.log(`  agents: ${agentsDir}`)
    console.log(`\nWatching for agent changes. Press Ctrl+C to stop.\n`)

    const shutdown = async () => {
      console.log("\nShutting down...")
      pushEvent(db, "sys", "sys.lifecycle.finish")
      await stopWatcher()
      await system.stop()
      db.close()
      process.exit(0)
    }

    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)

    await forever()
  },
})

const pushCommand = defineCommand({
  meta: { name: "push", description: "Push an event to the queue" },
  args: {
    ...globalArgs,
    worker: {
      type: "string",
      description: "Worker ID",
      required: true,
    },
    type: {
      type: "string",
      description: "Event type",
      required: true,
    },
    payload: {
      type: "string",
      description: "Event payload as JSON (default: {})",
    },
  },
  run: ({ args }) => {
    const { db } = ensureDb(args.dir, args.db)
    try {
      const payload = args.payload ? JSON.parse(args.payload) : {}
      const event = pushEvent(db, args.worker, args.type, payload)
      console.log(JSON.stringify(event))
    } finally {
      db.close()
    }
  },
})

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
    const { db } = ensureDb(args.dir, args.db)
    try {
      const tail = args.tail ? parseInt(args.tail, 10) : 20
      const events = getEventsSince(db, {
        tail: isNaN(tail) ? 20 : tail,
        filterType: args.type,
      })
      if (events.length === 0) {
        console.error("No events found.")
        return
      }
      for (const event of events) {
        console.log(JSON.stringify(event))
      }
    } finally {
      db.close()
    }
  },
})

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
    const agentsDir = resolveAgentsDir(args.dir, args["agents-dir"])
    const agents = loadAllAgents(agentsDir)
    if (agents.length === 0) {
      console.log(`No agents found in ${agentsDir}`)
      return
    }
    for (const agent of agents) {
      const listen = agent.listen.length > 0 ? agent.listen.join(", ") : "(none)"
      const emits = agent.emits.length > 0 ? agent.emits.join(", ") : "(none)"
      console.log(`${agent.id} (${agent.type})`)
      if (agent.description) console.log(`  ${agent.description}`)
      console.log(`  listen: ${listen}`)
      console.log(`  emits:  ${emits}`)
      console.log()
    }
  },
})

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
    const { db } = ensureDb(args.dir, args.db)
    try {
      const claimed = claimEvent(db, args.worker, parseInt(args.event, 10))
      const claimant = getClaimant(db, parseInt(args.event, 10))
      console.log(JSON.stringify({ claimed, claimant }))
    } finally {
      db.close()
    }
  },
})

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
    const { db } = ensureDb(args.dir, args.db)
    try {
      const claimant = getClaimant(db, parseInt(args.event, 10))
      console.log(JSON.stringify({ claimant: claimant ?? null }))
    } finally {
      db.close()
    }
  },
})

// -- Main command ------------------------------------------------------------

const main = defineCommand({
  meta: {
    name: "busytown",
    version: "0.1.0",
    description: "Busytown event queue CLI",
  },
  subCommands: {
    start: startCommand,
    push: pushCommand,
    events: eventsCommand,
    agents: agentsCommand,
    claim: claimCommand,
    "check-claim": checkClaimCommand,
  },
})

runMain(main)
