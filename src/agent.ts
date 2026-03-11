import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import matter from "gray-matter";
import fs from "node:fs";
import path from "node:path";
import { pathToSlug } from "./lib/slug.ts";
import { logger } from "./lib/json-logger.ts";

const AgentFrontmatterSchema = Type.Object(
  {
    name: Type.Optional(Type.String()),
    type: Type.Optional(
      Type.Union([Type.Literal("pi"), Type.Literal("shell")]),
    ),
    description: Type.Optional(Type.String()),
    listen: Type.Optional(Type.Array(Type.String())),
    ignore_self: Type.Optional(Type.Boolean()),
    emits: Type.Optional(Type.Array(Type.String())),
    tools: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())]),
    ),
    model: Type.Optional(Type.String()),
    memory_blocks: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object({
          description: Type.Optional(Type.String()),
          value: Type.Optional(Type.String()),
          char_limit: Type.Optional(Type.Number()),
        }),
      ),
    ),
  },
  { additionalProperties: true },
);

export type AgentFrontmatter = Static<typeof AgentFrontmatterSchema>;

export type MemoryBlockDef = {
  description: string;
  value: string;
  charLimit: number;
};

const parseMemoryBlocks = (
  raw: AgentFrontmatter["memory_blocks"],
): Record<string, MemoryBlockDef> => {
  if (!raw) return {};
  const result: Record<string, MemoryBlockDef> = {};
  for (const [key, block] of Object.entries(raw)) {
    result[key] = {
      description: block.description ?? "",
      value: block.value ?? "",
      charLimit: block.char_limit ?? 2000,
    };
  }
  return result;
};

const applyDefaults = (raw: AgentFrontmatter) => ({
  name: raw.name,
  type: raw.type ?? ("pi" as const),
  description: raw.description ?? "",
  listen: raw.listen ?? [],
  ignore_self: raw.ignore_self ?? true,
  emits: raw.emits ?? [],
  tools:
    typeof raw.tools === "string"
      ? raw.tools.split(",").map((s) => s.trim())
      : (raw.tools ?? []),
  model: raw.model,
  memoryBlocks: parseMemoryBlocks(raw.memory_blocks),
});

export type PiAgentDef = {
  id: string;
  filePath: string;
  type: "pi";
  description: string;
  listen: string[];
  ignoreSelf: boolean;
  emits: string[];
  tools: string[];
  body: string;
  model?: string;
  memoryBlocks: Record<string, MemoryBlockDef>;
};

export type ShellAgentDef = {
  id: string;
  filePath: string;
  type: "shell";
  description: string;
  listen: string[];
  ignoreSelf: boolean;
  emits: string[];
  body: string;
  memoryBlocks: Record<string, MemoryBlockDef>;
};

export type AgentDef = PiAgentDef | ShellAgentDef;

export const loadAgentDef = (filePath: string): AgentDef => {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);
  const cleaned = Value.Clean(AgentFrontmatterSchema, data);
  const checked = Value.Check(AgentFrontmatterSchema, cleaned);
  if (!checked) {
    const errors = [...Value.Errors(AgentFrontmatterSchema, cleaned)];
    throw new Error(
      `Invalid agent frontmatter: ${errors.map((e) => e.message).join(", ")}`,
    );
  }
  const frontmatter = applyDefaults(cleaned as AgentFrontmatter);
  const id = frontmatter.name ?? pathToSlug(filePath);
  if (!id) {
    throw new Error(`Cannot derive agent ID from path: ${filePath}`);
  }

  if (frontmatter.type === "shell") {
    return {
      id,
      filePath,
      type: "shell",
      description: frontmatter.description,
      listen: frontmatter.listen,
      ignoreSelf: frontmatter.ignore_self,
      emits: frontmatter.emits,
      body: content,
      memoryBlocks: frontmatter.memoryBlocks,
    };
  }

  return {
    id,
    filePath,
    type: "pi",
    description: frontmatter.description,
    listen: frontmatter.listen,
    ignoreSelf: frontmatter.ignore_self,
    emits: frontmatter.emits,
    tools: frontmatter.tools,
    body: content.trim(),
    model: frontmatter.model,
    memoryBlocks: frontmatter.memoryBlocks,
  };
};

/** Updates the frontmatter of an agent file in-place. */
export const updateAgentFrontmatter = (
  filePath: string,
  updater: (frontmatter: AgentFrontmatter) => AgentFrontmatter,
): void => {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);
  if (!Value.Check(AgentFrontmatterSchema, data)) {
    const errors = [...Value.Errors(AgentFrontmatterSchema, data)];
    throw new Error(
      `Invalid agent frontmatter in ${filePath}: ${errors.map((e) => e.message).join(", ")}`,
    );
  }
  const updated = updater({ ...data } as AgentFrontmatter);
  const output = matter.stringify(content, updated);
  fs.writeFileSync(filePath, output);
};

export const loadAllAgents = (agentsDir: string): AgentDef[] => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const agents: AgentDef[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    try {
      agents.push(loadAgentDef(path.join(agentsDir, entry.name)));
    } catch (err) {
      logger.error("Failed to load agent", {
        file: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return agents;
};
