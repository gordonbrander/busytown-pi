import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parseSlug } from "../lib/slug.ts";
import { truncate, type TruncationReceipt } from "../lib/truncate.ts";

export type MemoryBlock = {
  description: string;
  value: string;
  charLimit: number;
};

export const MemoryBlockEntrySchema = Type.Object({
  description: Type.String({ default: "" }),
  char_limit: Type.Number({ default: 2000 }),
});

export type MemoryBlockEntry = Static<typeof MemoryBlockEntrySchema>;

const MemoryBlocksRecordSchema = Type.Record(Type.String(), Type.Unknown());

export const parseMemoryBlockEntries = (
  raw: unknown,
): Record<string, MemoryBlockEntry> => {
  if (!Value.Check(MemoryBlocksRecordSchema, raw)) return {};
  const result: Record<string, MemoryBlockEntry> = {};
  for (const [key, block] of Object.entries(raw)) {
    Value.Default(MemoryBlockEntrySchema, block);
    result[key] = block as MemoryBlockEntry;
  }
  return result;
};

export const memoryBlockPath = (
  cwd: string,
  agentId: string,
  blockKey: string,
): string =>
  path.join(cwd, ".pi", "busytown", "memory_blocks", agentId, `${blockKey}.md`);

export const readMemoryBlockValue = (
  cwd: string,
  agentId: string,
  blockKey: string,
): string => {
  const filePath = memoryBlockPath(cwd, agentId, blockKey);
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
};

export const writeMemoryBlockValue = (
  cwd: string,
  agentId: string,
  blockKey: string,
  value: string,
): void => {
  const filePath = memoryBlockPath(cwd, agentId, blockKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
};

/** Hydrate memory block entries with values from disk. */
export const hydrateMemoryBlocks = (
  cwd: string,
  agentId: string,
  entries: Record<string, MemoryBlockEntry>,
): Record<string, MemoryBlock> => {
  const result: Record<string, MemoryBlock> = {};
  for (const [key, entry] of Object.entries(entries)) {
    result[key] = {
      description: entry.description,
      charLimit: entry.char_limit,
      value: readMemoryBlockValue(cwd, agentId, key),
    };
  }
  return result;
};

export const applyMemoryUpdate = (
  currentValue: string,
  charLimit: number,
  newText: string,
  oldText?: string,
): TruncationReceipt => {
  if (oldText !== undefined) {
    // Replace mode
    if (!currentValue.includes(oldText)) {
      throw new TypeError(
        `oldText not found in memory block. Current value:\n${currentValue}`,
      );
    }
    return truncate(currentValue.replace(oldText, newText), charLimit);
  } else {
    // Append mode
    return truncate([currentValue, newText].join("\n").trim(), charLimit);
  }
};

export const renderMemoryBlockEntry = (
  key: string,
  block: MemoryBlock,
): string => {
  const tag = parseSlug(key);
  return `<${tag}>
  <description>${block.description ?? ""}</description>
  <metadata>
    char_count: ${block.value.length}
    char_limit: ${block.charLimit}
  </metadata>
  <value>${block.value}</value>
</${tag}>
`;
};

export const renderMemoryBlocksPrompt = (
  blocks: Record<string, MemoryBlock>,
  updateInstruction = "Use the `updateMemory` tool to store important information you learn.",
): string => {
  const keys = Object.keys(blocks);
  if (keys.length === 0) return "";

  return `
## Memory

You have persistent memory blocks that survive across agent invocations.

${updateInstruction}

Review your memory blocks below and keep them up to date.

<memory_blocks>
${keys.map((key) => renderMemoryBlockEntry(key, blocks[key])).join("\n")}
</memory_blocks>
`;
};
