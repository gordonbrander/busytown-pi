import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import matter from "gray-matter";
import fs from "node:fs";
import path from "node:path";
import { glob as globDir } from "node:fs/promises";
import { pathToSlug } from "../lib/slug.ts";
import { guessProvider } from "./pi-agent-shared.ts";
import {
  type MemoryBlock,
  MemoryBlockEntrySchema,
  parseMemoryBlockEntries,
  hydrateMemoryBlocks,
} from "../memory/memory.ts";

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
      [
        Type.Literal("pi"),
        Type.Literal("pi-rpc"),
        Type.Literal("shell"),
        Type.Literal("claude"),
      ],
      { default: "pi" },
    ),
    description: Type.String({ default: "" }),
    listen: Type.Array(Type.String(), { default: [] }),
    ignore_self: Type.Boolean({ default: true }),
    emits: Type.Array(Type.String(), { default: [] }),
    tools: Type.Array(Type.String(), { default: [] }),
    model: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    memory_blocks: Type.Optional(
      Type.Record(Type.String(), MemoryBlockEntrySchema),
    ),
    hooks: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: true },
);

export type AgentFrontmatter = Static<typeof AgentFrontmatterSchema>;

export type MemoryBlockDef = MemoryBlock;

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
  d.memory_blocks = parseMemoryBlockEntries(d.memory_blocks);

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
  provider?: string;
  memoryBlocks: Record<string, MemoryBlockDef>;
  hooks: Hooks;
};

export type PiRpcAgentDef = {
  id: string;
  filePath: string;
  type: "pi-rpc";
  description: string;
  listen: string[];
  ignoreSelf: boolean;
  emits: string[];
  tools: string[];
  body: string;
  model?: string;
  provider?: string;
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

export type AgentDef =
  | PiAgentDef
  | PiRpcAgentDef
  | ShellAgentDef
  | ClaudeAgentDef;

export const loadAgentDef = (filePath: string, cwd: string): AgentDef => {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);
  const fm = parseAgentFrontmatter(data);
  const id = pathToSlug(filePath);
  if (!id) {
    throw new Error(`Cannot derive agent ID from path: ${filePath}`);
  }

  const memoryBlocks = hydrateMemoryBlocks(
    cwd,
    id,
    parseMemoryBlockEntries(fm.memory_blocks),
  );

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

  if (fm.type === "pi-rpc") {
    return {
      id,
      filePath,
      type: "pi-rpc",
      description: fm.description,
      listen: fm.listen,
      ignoreSelf: fm.ignore_self,
      emits: fm.emits,
      tools: fm.tools,
      body: content.trim(),
      model: fm.model,
      provider: fm.provider ?? (fm.model ? guessProvider(fm.model) : undefined),
      memoryBlocks,
      hooks: fm.hooks ?? {},
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
    provider: fm.provider ?? (fm.model ? guessProvider(fm.model) : undefined),
    memoryBlocks,
    hooks: fm.hooks ?? {},
  };
};

/**
 * Asynchronously lists all agent paths in the given directory.
 * @param agentDir The directory to search for agent files.
 * @returns An async generator that yields the full paths of agent files.
 */
export async function* listAgentPaths(
  agentDir: string,
): AsyncGenerator<string> {
  for await (const agentPath of globDir("*.md", { cwd: agentDir })) {
    yield path.resolve(agentDir, agentPath);
  }
}

export async function* listAgentDefs(
  agentDir: string,
  cwd: string,
): AsyncGenerator<AgentDef> {
  for await (const agentPath of listAgentPaths(agentDir)) {
    yield loadAgentDef(agentPath, cwd);
  }
}
