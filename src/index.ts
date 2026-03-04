import path from "node:path"
import { z } from "zod/v4"
import type { DatabaseSync } from "node:sqlite"
import { openDb, pushEvent, getEventsSince, claimEvent, getClaimant } from "./event-queue.ts"
import { loadAllAgents } from "./agent.ts"
import { createSystem, type WorkerSystem } from "./worker.ts"
import { makeAgentWorker } from "./pi-process.ts"
import { watchAgents, type AgentWatcherCleanup } from "./agent-watcher.ts"

type ExtensionAPI = {
  on: (event: string, handler: (...args: unknown[]) => Promise<void>) => void
  registerTool: (tool: {
    name: string
    label?: string
    description: string
    parameters: unknown
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>
  }) => void
}

// Extension state
let db: DatabaseSync | undefined
let system: WorkerSystem | undefined
let watcherCleanup: AgentWatcherCleanup | undefined

const resolveDbPath = (projectRoot: string): string =>
  path.join(projectRoot, ".busytown", "events.db")

const resolveAgentsDir = (projectRoot: string): string =>
  path.join(projectRoot, ".pi", "agents")

const resolveCliBin = (): string => {
  // Resolve the CLI binary path relative to this extension
  return path.join(path.dirname(new URL(import.meta.url).pathname), "cli.ts")
}

export default (pi: ExtensionAPI) => {
  pi.on("session_start", async (_event: unknown, _ctx: unknown) => {
    const projectRoot = process.cwd()
    const dbPath = resolveDbPath(projectRoot)
    const agentsDir = resolveAgentsDir(projectRoot)
    const cliBin = resolveCliBin()

    // Ensure .busytown directory exists
    const { mkdirSync } = await import("node:fs")
    mkdirSync(path.dirname(dbPath), { recursive: true })

    db = openDb(dbPath)
    system = createSystem(db)

    // Load agents with listen fields and spawn workers
    const agents = loadAllAgents(agentsDir)
    const toWorker = makeAgentWorker(db, dbPath, projectRoot, cliBin)

    for (const agent of agents) {
      if (agent.listen.length === 0) continue
      try {
        system.spawn(toWorker(agent))
      } catch (err) {
        console.error(`Failed to spawn worker for agent "${agent.id}":`, err)
      }
    }

    // Start watching for agent file changes
    watcherCleanup = watchAgents(agentsDir, system, db, dbPath, projectRoot, cliBin)

    pushEvent(db, "sys", "sys.lifecycle.start")

    // Register tools
    pi.registerTool({
      name: "busytown-push",
      label: "Busytown Push",
      description:
        "Push an event to the Busytown event queue to trigger agent workflows. " +
        "Common event types: plan.request, code.request, review.request",
      parameters: z.toJSONSchema(
        z.object({
          type: z.string().describe("Event type (e.g. 'plan.request')"),
          payload: z.string().optional().describe("JSON payload string (default: '{}')"),
        }),
      ),
      async execute(_toolCallId, params) {
        if (!db) throw new Error("Busytown not initialized")
        const payload = params.payload ? JSON.parse(params.payload as string) : {}
        const event = pushEvent(db, "host", params.type as string, payload)
        return {
          content: [{ type: "text", text: JSON.stringify(event, null, 2) }],
          details: {},
        }
      },
    })

    pi.registerTool({
      name: "busytown-events",
      label: "Busytown Events",
      description: "List recent events from the Busytown event queue",
      parameters: z.toJSONSchema(
        z.object({
          tail: z.number().int().optional().describe("Number of recent events to show (default: 20)"),
          type: z.string().optional().describe("Filter by event type"),
        }),
      ),
      async execute(_toolCallId, params) {
        if (!db) throw new Error("Busytown not initialized")
        const events = getEventsSince(db, {
          tail: (params.tail as number) ?? 20,
          filterType: params.type as string,
        })
        return {
          content: [{ type: "text", text: JSON.stringify(events, null, 2) }],
          details: {},
        }
      },
    })

    pi.registerTool({
      name: "busytown-claim",
      label: "Busytown Claim",
      description: "Claim an event so no other agent processes it",
      parameters: z.toJSONSchema(
        z.object({
          event_id: z.number().int().describe("Event ID to claim"),
          worker: z.string().describe("Worker ID claiming the event"),
        }),
      ),
      async execute(_toolCallId, params) {
        if (!db) throw new Error("Busytown not initialized")
        const claimed = claimEvent(db, params.worker as string, params.event_id as number)
        const claimant = getClaimant(db, params.event_id as number)
        return {
          content: [{ type: "text", text: JSON.stringify({ claimed, claimant }, null, 2) }],
          details: {},
        }
      },
    })
  })

  pi.on("session_shutdown", async () => {
    if (db) {
      pushEvent(db, "sys", "sys.lifecycle.finish")
    }
    if (watcherCleanup) {
      await watcherCleanup()
      watcherCleanup = undefined
    }
    if (system) {
      await system.stop()
      system = undefined
    }
    if (db) {
      db.close()
      db = undefined
    }
  })
}
