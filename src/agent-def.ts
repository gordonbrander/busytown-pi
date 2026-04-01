/**
 * @module Loads and parses agent files into agent config objects
 */
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import matter from "gray-matter";
import fs from "node:fs";
import path from "node:path";
import { pathToSlug } from "./lib/slug.ts";
import { loggerOf } from "./lib/json-logger.ts";
import { piRpcAgentOf } from "./pi-rpc-agent.ts";

const logger = loggerOf({ source: "agent-def.ts" });

export const MemoryBlockEntrySchema = Type.Object({
  description: Type.String({ default: "" }),
  value: Type.String({ default: "" }),
  char_limit: Type.Number({ default: 2000 }),
});

export type MemoryBlockEntry = Static<typeof MemoryBlockEntrySchema>;

export const HOOK_NAMES = [
  "session_start",
  "session_shutdown",
  "session_before_switch",
  "session_switch",
  "session_before_fork",
  "session_fork",
  "session_before_compact",
  "session_compact",
  "session_before_tree",
  "session_tree",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "tool_call",
  "tool_result",
  "input",
  "model_select",
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

export type Hooks = Partial<Record<HookName, string>>;

export const isHookName = (name: string): name is HookName =>
  (HOOK_NAMES as readonly string[]).includes(name);

export const AgentFrontmatterSchema = Type.Object(
  {
    name: Type.Optional(Type.String()),
    type: Type.Union(
      [Type.Literal("pi"), Type.Literal("shell"), Type.Literal("claude")],
      { default: "pi" },
    ),
    description: Type.String({ default: "" }),
    listen: Type.Array(Type.String(), { default: [] }),
    ignore_self: Type.Boolean({ default: true }),
    emits: Type.Array(Type.String(), { default: [] }),
    tools: Type.Array(Type.String(), { default: [] }),
    model: Type.Optional(Type.String()),
    memory_blocks: Type.Optional(
      Type.Record(Type.String(), MemoryBlockEntrySchema),
    ),
    hooks: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: true },
);

export type AgentFrontmatter = Static<typeof AgentFrontmatterSchema>;

export type MemoryBlockDef = {
  description: string;
  value: string;
  charLimit: number;
};

const MemoryBlocksRecordSchema = Type.Record(Type.String(), Type.Unknown());

const parseMemoryBlocks = (raw: unknown): Record<string, MemoryBlockDef> => {
  if (!Value.Check(MemoryBlocksRecordSchema, raw)) return {};
  const result: Record<string, MemoryBlockDef> = {};
  for (const [key, block] of Object.entries(raw)) {
    Value.Default(MemoryBlockEntrySchema, block);
    const entry = block as MemoryBlockEntry;
    result[key] = {
      description: entry.description,
      value: entry.value,
      charLimit: entry.char_limit,
    };
  }
  return result;
};

/** Normalize a raw hooks record: strip nulls, keep only valid hook names. */
export const parseHooks = (raw: unknown): Hooks => {
  if (!raw || typeof raw !== "object") return {};
  const hooks: Hooks = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && isHookName(key)) {
      hooks[key] = value;
    }
  }
  return hooks;
};

/** Apply defaults, validate, and return typed frontmatter. Throws on invalid input. */
const parseAgentFrontmatter = (data: unknown): AgentFrontmatter => {
  Value.Default(AgentFrontmatterSchema, data);
  const d = data as Record<string, unknown>;

  d.hooks = parseHooks(d.hooks);

  parseMemoryBlocks(d.memory_blocks);
  if (!Value.Check(AgentFrontmatterSchema, data)) {
    const errors = [...Value.Errors(AgentFrontmatterSchema, data)];
    throw new Error(
      `Invalid agent frontmatter: ${errors.map((e) => `${e.path}: ${e.message}`).join(", ")}`,
    );
  }
  return data as AgentFrontmatter;
};

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
  hooks: Hooks;
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

export type ClaudeAgentDef = {
  id: string;
  filePath: string;
  type: "claude";
  description: string;
  listen: string[];
  ignoreSelf: boolean;
  emits: string[];
  tools: string[];
  body: string;
  model?: string;
  memoryBlocks: Record<string, MemoryBlockDef>;
};

export type AgentDef = PiAgentDef | ShellAgentDef | ClaudeAgentDef;

export const loadAgentDef = (filePath: string): AgentDef => {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);
  const fm = parseAgentFrontmatter(data);
  const id = pathToSlug(filePath);
  if (!id) {
    throw new Error(`Cannot derive agent ID from path: ${filePath}`);
  }

  const memoryBlocks = parseMemoryBlocks(fm.memory_blocks);

  if (fm.type === "shell") {
    return {
      id,
      filePath,
      type: "shell",
      description: fm.description,
      listen: fm.listen,
      ignoreSelf: fm.ignore_self,
      emits: fm.emits,
      body: content,
      memoryBlocks,
    };
  }

  if (fm.type === "claude") {
    return {
      id,
      filePath,
      type: "claude",
      description: fm.description,
      listen: fm.listen,
      ignoreSelf: fm.ignore_self,
      emits: fm.emits,
      tools: fm.tools,
      body: content.trim(),
      model: fm.model,
      memoryBlocks,
    };
  }

  return {
    id,
    filePath,
    type: "pi",
    description: fm.description,
    listen: fm.listen,
    ignoreSelf: fm.ignore_self,
    emits: fm.emits,
    tools: fm.tools,
    body: content.trim(),
    model: fm.model,
    memoryBlocks,
    hooks: fm.hooks ?? {},
  };
};

/** Updates the frontmatter of an agent file in-place. */
export const updateAgentFrontmatter = (
  filePath: string,
  updater: (frontmatter: AgentFrontmatter) => AgentFrontmatter,
): void => {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);
  const fm = parseAgentFrontmatter(data);
  const updated = updater({ ...fm });
  const output = matter.stringify(content, updated);
  fs.writeFileSync(filePath, output);
};

/** Loads all agent definitions from the given directory. */
export const loadAgentDefs = (agentsDir: string): AgentDef[] => {
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

export const loadAgentOf = async (path: string): Agent => {
  const agentDef = loadAgentDef(path);

  switch (agentDef.type) {
    case "pi":
      return piRpcAgentOf({
        id: agentDef.id,
        listen: agentDef.listen,
        ignoreSelf: agentDef.ignoreSelf,
        env: process.env,
        cwd: process.cwd(),
        extensions: agentDef,
      })
      break;
    case "shell":
      break;
    case "claude":
      break;
  }
};
