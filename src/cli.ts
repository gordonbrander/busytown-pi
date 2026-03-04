#!/usr/bin/env node

import { openDb, pushEvent, claimEvent, getClaimant } from "./event-queue.ts"

const usage = `busytown <command> [options]

Commands:
  push          Push an event to the queue
  claim         Claim an event
  check-claim   Check who claimed an event

Options:
  --db <path>       Path to SQLite database (required)
  --worker <id>     Worker ID (required for push/claim)
  --type <type>     Event type (required for push)
  --payload <json>  Event payload as JSON (optional, default: {})
  --event <id>      Event ID (required for claim/check-claim)
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

const main = (): void => {
  const args = parseArgs(process.argv.slice(2))
  const command = args._command

  if (!command) {
    console.error(usage)
    process.exit(1)
  }

  const dbPath = args.db
  if (!dbPath) die("Missing --db <path>")

  const db = openDb(dbPath)

  try {
    switch (command) {
      case "push": {
        const workerId = args.worker
        const type = args.type
        if (!workerId) die("Missing --worker <id>")
        if (!type) die("Missing --type <type>")
        const payload = args.payload ? JSON.parse(args.payload) : {}
        const event = pushEvent(db, workerId, type, payload)
        console.log(JSON.stringify(event))
        break
      }

      case "claim": {
        const workerId = args.worker
        const eventId = args.event
        if (!workerId) die("Missing --worker <id>")
        if (!eventId) die("Missing --event <id>")
        const claimed = claimEvent(db, workerId, parseInt(eventId, 10))
        const claimant = getClaimant(db, parseInt(eventId, 10))
        console.log(JSON.stringify({ claimed, claimant }))
        break
      }

      case "check-claim": {
        const eventId = args.event
        if (!eventId) die("Missing --event <id>")
        const claimant = getClaimant(db, parseInt(eventId, 10))
        console.log(JSON.stringify({ claimant: claimant ?? null }))
        break
      }

      default:
        die(`Unknown command: ${command}`)
    }
  } finally {
    db.close()
  }
}

main()
