import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import fs from "node:fs"
import path from "node:path"
import type { DatabaseSync } from "node:sqlite"
import type { Event } from "./event.ts"
import type { PiAgentDef, ShellAgentDef, AgentDef } from "./agent.ts"
import { pushEvent } from "./event-queue.ts"
import { renderTemplate } from "./template.ts"
import { worker, type Worker } from "./worker.ts"

const buildSystemPrompt = (agent: PiAgentDef, dbPath: string, cliBin: string): string => {
  const lines = [
    `You are the "${agent.id}" agent. ${agent.description}`,
    "",
    "## Pushing events",
    "",
    "To push an event to the Busytown event queue, run:",
    "```",
    `${cliBin} push --db ${dbPath} --worker ${agent.id} --type <event-type> --payload '<json>'`,
    "```",
    "",
    "## Claiming events",
    "",
    "Before doing significant work on an event, claim it to prevent other agents from processing it:",
    "```",
    `${cliBin} claim --db ${dbPath} --worker ${agent.id} --event <event-id>`,
    "```",
    "",
    "If the claim returns `false`, another agent has already claimed it — skip the event.",
    "",
  ]

  if (agent.body) {
    lines.push("## Agent instructions", "", agent.body)
  }

  return lines.join("\n")
}

const writeSystemPromptFile = (
  agent: PiAgentDef,
  dbPath: string,
  cliBin: string,
  projectRoot: string,
): string => {
  const dir = path.join(projectRoot, ".busytown")
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `system-prompt-${agent.id}.md`)
  fs.writeFileSync(filePath, buildSystemPrompt(agent, dbPath, cliBin))
  return filePath
}

const pipeLinesToEvents = (
  child: ChildProcess,
  stream: "stdout" | "stderr",
  db: DatabaseSync,
  workerId: string,
  eventType: string,
): void => {
  const readable = child[stream]
  if (!readable) return
  const rl = createInterface({ input: readable })
  rl.on("line", (line) => {
    pushEvent(db, workerId, eventType, { line })
  })
}

export const runPiAgent = (
  agent: PiAgentDef,
  event: Event,
  dbPath: string,
  projectRoot: string,
  db: DatabaseSync,
  cliBin: string,
): Promise<number> => {
  const systemPromptFile = writeSystemPromptFile(agent, dbPath, cliBin, projectRoot)

  const args = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--append-system-prompt", systemPromptFile,
  ]

  if (agent.model) {
    args.push("--model", agent.model)
  }

  if (agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","))
  }

  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    })

    pipeLinesToEvents(child, "stdout", db, agent.id, `sys.worker.${agent.id}.stdout`)
    pipeLinesToEvents(child, "stderr", db, agent.id, `sys.worker.${agent.id}.stderr`)

    // Write event JSON as the task prompt on stdin
    child.stdin?.write(JSON.stringify(event))
    child.stdin?.end()

    child.on("error", reject)
    child.on("close", (code) => resolve(code ?? 1))
  })
}

export const runShellAgent = (
  agent: ShellAgentDef,
  event: Event,
  projectRoot: string,
  db: DatabaseSync,
): Promise<number> => {
  const rendered = renderTemplate(agent.body, { event })

  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", rendered], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    })

    pipeLinesToEvents(child, "stdout", db, agent.id, `sys.worker.${agent.id}.stdout`)
    pipeLinesToEvents(child, "stderr", db, agent.id, `sys.worker.${agent.id}.stderr`)

    child.on("error", reject)
    child.on("close", (code) => resolve(code ?? 1))
  })
}

export const makeAgentWorker = (
  db: DatabaseSync,
  dbPath: string,
  projectRoot: string,
  cliBin: string,
): ((agent: AgentDef) => Worker) => {
  return (agent: AgentDef): Worker =>
    worker({
      id: agent.id,
      listen: agent.listen,
      ignoreSelf: agent.ignoreSelf,
      run: async (event, { abortSignal }) => {
        if (agent.type === "pi") {
          await runPiAgent(agent, event, dbPath, projectRoot, db, cliBin)
        } else {
          await runShellAgent(agent, event, projectRoot, db)
        }
        // If aborted during run, that's fine — the process already completed or was killed
      },
    })
}
