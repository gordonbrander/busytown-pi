import type { MemoryBlockDef } from "./agent.ts";
import * as Lines from "./lib/lines.ts";

export type MemoryUpdateResult = {
  value: string;
  truncated: boolean;
};

export const applyMemoryUpdate = (
  currentValue: string,
  charLimit: number,
  newText: string,
  oldText?: string,
): MemoryUpdateResult => {
  let value: string;

  if (oldText !== undefined) {
    // Replace mode
    if (!currentValue.includes(oldText)) {
      throw new Error(
        `oldText not found in memory block. Current value:\n${currentValue}`,
      );
    }
    value = currentValue.replace(oldText, newText);
  } else {
    // Append mode
    value = currentValue ? currentValue + "\n" + newText : newText;
  }

  const truncated = value.length > charLimit;
  if (truncated) {
    value = value.slice(0, charLimit);
  }

  return { value, truncated };
};

export const renderMemoryBlockEntry = (
  key: string,
  block: MemoryBlockDef,
): string =>
  Lines.join([
    `<${key}>`,
    ...Lines.indent([
      `<description>${block.description ?? ""}</description>`,
      `<metadata>`,
      `- chars_current: ${block.value.length}`,
      `- chars_limit: ${block.charLimit}`,
      `</metadata>`,
      `<value>${block.value}</value>`,
    ]),
    `</${key}>`,
  ]);

export const renderMemoryBlocksPrompt = (
  blocks: Record<string, MemoryBlockDef>,
): string => {
  const keys = Object.keys(blocks);
  if (keys.length === 0) return "";

  return Lines.join([
    "",
    "## Memory",
    "",
    "You have persistent memory blocks that survive across agent invocations.",
    "Use the updateMemory tool to store important information you learn.",
    "Review your memory blocks below and keep them up to date.",
    "",
    "<memory_blocks>",
    ...keys.map((key) => renderMemoryBlockEntry(key, blocks[key])),
    "</memory_blocks>",
  ]);
};
