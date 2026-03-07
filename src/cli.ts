#!/usr/bin/env node

import path from "node:path"
import fs from "node:fs"
import type { DatabaseSync } from "node:sqlite"
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

const usage = `busytown <command> [options]

Commands:
  start         Start the worker system (long-running)
  push          Push an event to the queue
  events        List recent events
  agents        List loaded agent definitions
  claim         Claim an event
  check-claim   Check who claimed an event

Global Options:
  --dir <path>      Project root directory (default: cwd)
  --db <path>       Path to SQLite database (default: <dir>/.busytown/events.db)

start Options:
  --agents-dir <path>  Agent definitions directory (default: <dir>/.pi/agents)

push Options:
  --worker <id>     Worker ID (required)
  --type <type>     Event type (required)
  --payload <json>  Event payload as JSON (default: {})

events Options:
  --tail <n>        Number of recent events to show (default: 20)
  --type <type>     Filter by event type

claim Options:
  --worker <id>     Worker ID (required)
  --event <id>      Event ID (required)

check-claim Options:
  --event <id>      Event ID (required)
`

const parseArgs = (argv: string[]): Record<string, string> => {
  const args: Record<string, string> = {}
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith("--") && i + 1 < argv.length) {
      args[arg.slice(2)] = argv[++i]
    } else {
      positional.push(arg)
    }
  }

  if (positional.length > 0) {
    args._command = positional[0]
  }

  return args
}

const die = (msg: string): never => {
  console.error(msg)
  process.exit(1)
}

const resolveDbPath = (args: Record<string, string>): string => {
  if (args.db) return args.db
  const dir = args.dir ?? process.cwd()
  return path.join(dir, ".busytown", "events.db")
}

const resolveAgentsDir = (args: Record<string, string>): string => {
  if (args["agents-dir"]) return args["agents-dir"]
  const dir = args.dir ?? process.cwd()
  return path.join(dir, ".pi", "agents")
}

const resolveProjectRoot = (args: Record<string, string>): string =>
  args.dir ?? process.cwd()

const resolveCliBin = (): string =>
  path.join(path.dirname(new URL(import.meta.url).pathname), "cli.ts")

const ensureDb = (args: Record<string, string>): { db: DatabaseSync; dbPath: string } => {
  const dbPath = resolveDbPath(args)
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = openDb(dbPath)
  return { db, dbPath }
}

const cmdStart = async (args: Record<string, string>): Promise<void> => {
  const projectRoot = resolveProjectRoot(args)
  const agentsDir = resolveAgentsDir(args)
  const cliBin = resolveCliBin()
  const { db, dbPath } = ensureDb(args)

  const system = createSystem(db)

  // Load agents and spawn workers
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

  // Start watching for agent file changes
  const stopWatcher = watchAgents(agentsDir, system, db, dbPath, projectRoot, cliBin)

  pushEvent(db, "sys", "sys.lifecycle.start")
  console.log(`\nBusytown started (${spawned} agent${spawned === 1 ? "" : "s"})`)
  console.log(`  db:     ${dbPath}`)
  console.log(`  agents: ${agentsDir}`)
  console.log(`\nWatching for agent changes. Press Ctrl+C to stop.\n`)

  // Graceful shutdown
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
}

const cmdPush = (args: Record<string, string>): void => {
  const workerId = args.worker
  const type = args.type
  if (!workerId) die("Missing --worker <id>")
  if (!type) die("Missing --type <type>")
  const { db } = ensureDb(args)
  try {
    const payload = args.payload ? JSON.parse(args.payload) : {}
    const event = pushEvent(db, workerId, type, payload)
    console.log(JSON.stringify(event))
  } finally {
    db.close()
  }
}

const cmdEvents = (args: Record<string, string>): void => {
  const { db } = ensureDb(args)
  try {
    const tail = args.tail ? parseInt(args.tail, 10) : 20
    const events = getEventsSince(db, {
      tail: isNaN(tail) ? 20 : tail,
      filterType: args.type,
    })
    if (events.length === 0) {
      console.log("No events found.")
      return
    }
    console.log(JSON.stringify(events, null, 2))
  } finally {
    db.close()
  }
}

const cmdAgents = (args: Record<string, string>): void => {
  const agentsDir = resolveAgentsDir(args)
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
}

const cmdClaim = (args: Record<string, string>): void => {
  const workerId = args.worker
  const eventId = args.event
  if (!workerId) die("Missing --worker <id>")
  if (!eventId) die("Missing --event <id>")
  const { db } = ensureDb(args)
  try {
    const claimed = claimEvent(db, workerId, parseInt(eventId, 10))
    const claimant = getClaimant(db, parseInt(eventId, 10))
    console.log(JSON.stringify({ claimed, claimant }))
  } finally {
    db.close()
  }
}

const cmdCheckClaim = (args: Record<string, string>): void => {
  const eventId = args.event
  if (!eventId) die("Missing --event <id>")
  const { db } = ensureDb(args)
  try {
    const claimant = getClaimant(db, parseInt(eventId, 10))
    console.log(JSON.stringify({ claimant: claimant ?? null }))
  } finally {
    db.close()
  }
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const command = args._command

  if (!command) {
    console.error(usage)
    process.exit(1)
  }

  switch (command) {
    case "start":
      await cmdStart(args)
      break
    case "push":
      cmdPush(args)
      break
    case "events":
      cmdEvents(args)
      break
    case "agents":
      cmdAgents(args)
      break
    case "claim":
      cmdClaim(args)
      break
    case "check-claim":
      cmdCheckClaim(args)
      break
    default:
      die(`Unknown command: ${command}`)
  }
}

main()
