import { z } from "zod/v4"
import matter from "gray-matter"
import fs from "node:fs"
import path from "node:path"
import { pathToSlug } from "./slug.ts"

const AgentFrontmatterSchema = z.object({
  name: z.string().optional(),
  type: z.enum(["pi", "shell"]).default("pi"),
  description: z.string().default(""),
  listen: z.array(z.string()).default([]),
  ignore_self: z.boolean().default(true),
  emits: z.array(z.string()).default([]),
  tools: z
    .union([z.string(), z.array(z.string())])
    .default([])
    .transform((v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()) : v)),
  model: z.string().optional(),
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
  const frontmatter = AgentFrontmatterSchema.parse(data)
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
