import { Type, type Static } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import matter from "gray-matter"
import fs from "node:fs"
import path from "node:path"
import { pathToSlug } from "./lib/slug.ts"

const AgentFrontmatterSchema = Type.Object({
  name: Type.Optional(Type.String()),
  type: Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("shell")])),
  description: Type.Optional(Type.String()),
  listen: Type.Optional(Type.Array(Type.String())),
  ignore_self: Type.Optional(Type.Boolean()),
  emits: Type.Optional(Type.Array(Type.String())),
  tools: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  model: Type.Optional(Type.String()),
})

type AgentFrontmatter = Static<typeof AgentFrontmatterSchema>

const applyDefaults = (raw: AgentFrontmatter) => ({
  name: raw.name,
  type: raw.type ?? "pi" as const,
  description: raw.description ?? "",
  listen: raw.listen ?? [],
  ignore_self: raw.ignore_self ?? true,
  emits: raw.emits ?? [],
  tools: typeof raw.tools === "string"
    ? raw.tools.split(",").map((s) => s.trim())
    : raw.tools ?? [],
  model: raw.model,
})

export type PiAgentDef = {
  id: string
  type: "pi"
  description: string
  listen: string[]
  ignoreSelf: boolean
  emits: string[]
  tools: string[]
  body: string
  model?: string
}

export type ShellAgentDef = {
  id: string
  type: "shell"
  description: string
  listen: string[]
  ignoreSelf: boolean
  emits: string[]
  body: string
}

export type AgentDef = PiAgentDef | ShellAgentDef

export const loadAgentDef = (filePath: string): AgentDef => {
  const raw = fs.readFileSync(filePath, "utf-8")
  const { data, content } = matter(raw)
  const cleaned = Value.Clean(AgentFrontmatterSchema, data)
  const checked = Value.Check(AgentFrontmatterSchema, cleaned)
  if (!checked) {
    const errors = [...Value.Errors(AgentFrontmatterSchema, cleaned)]
    throw new Error(`Invalid agent frontmatter: ${errors.map((e) => e.message).join(", ")}`)
  }
  const frontmatter = applyDefaults(cleaned as AgentFrontmatter)
  const id = frontmatter.name ?? pathToSlug(filePath)
  if (!id) {
    throw new Error(`Cannot derive agent ID from path: ${filePath}`)
  }

  if (frontmatter.type === "shell") {
    return {
      id,
      type: "shell",
      description: frontmatter.description,
      listen: frontmatter.listen,
      ignoreSelf: frontmatter.ignore_self,
      emits: frontmatter.emits,
      body: content,
    }
  }

  return {
    id,
    type: "pi",
    description: frontmatter.description,
    listen: frontmatter.listen,
    ignoreSelf: frontmatter.ignore_self,
    emits: frontmatter.emits,
    tools: frontmatter.tools,
    body: content.trim(),
    model: frontmatter.model,
  }
}

export const loadAllAgents = (agentsDir: string): AgentDef[] => {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }

  const agents: AgentDef[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    try {
      agents.push(loadAgentDef(path.join(agentsDir, entry.name)))
    } catch (err) {
      console.error(`Failed to load agent ${entry.name}:`, err)
    }
  }
  return agents
}
