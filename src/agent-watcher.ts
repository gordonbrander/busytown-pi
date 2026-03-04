import { watch } from "chokidar"
import path from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { loadAgentDef } from "./agent.ts"
import { pushEvent } from "./event-queue.ts"
import { makeAgentWorker } from "./pi-process.ts"
import type { WorkerSystem } from "./worker.ts"

export type AgentWatcherCleanup = () => Promise<void>

export const watchAgents = (
  agentsDir: string,
  system: WorkerSystem,
  db: DatabaseSync,
  dbPath: string,
  projectRoot: string,
  cliBin: string,
): AgentWatcherCleanup => {
  const knownIds = new Set<string>()
  const toWorker = makeAgentWorker(db, dbPath, projectRoot, cliBin)

  const watcher = watch(agentsDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300 },
  })

  const handleAddOrChange = async (filePath: string) => {
    if (!filePath.endsWith(".md")) return
    try {
      const agent = loadAgentDef(filePath)
      if (agent.listen.length === 0) return

      const wasKnown = knownIds.has(agent.id)
      await system.kill(agent.id)
      knownIds.add(agent.id)
      system.spawn(toWorker(agent))

      const eventType = wasKnown ? "sys.agent.reload" : "sys.agent.create"
      pushEvent(db, "sys", eventType, { agent_id: agent.id, path: filePath })
    } catch (err) {
      const agentId = path.basename(filePath, ".md")
      pushEvent(db, "sys", "sys.agent.error", {
        agent_id: agentId,
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleUnlink = async (filePath: string) => {
    if (!filePath.endsWith(".md")) return
    const agentId = path.basename(filePath, ".md")
    if (knownIds.has(agentId)) {
      await system.kill(agentId)
      knownIds.delete(agentId)
      pushEvent(db, "sys", "sys.agent.remove", { agent_id: agentId, path: filePath })
    }
  }

  watcher.on("add", handleAddOrChange)
  watcher.on("change", handleAddOrChange)
  watcher.on("unlink", handleUnlink)

  return async () => {
    await watcher.close()
  }
}
