import type { MemoryBlockDef } from "./agent.ts";
import * as Lines from "./lib/lines.ts";
import { truncate, type TruncationReceipt } from "./lib/truncate.ts";

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
    return truncate(Lines.join([currentValue, newText]).trim(), charLimit);
  }
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
      `- char_count: ${block.value.length}`,
      `- char_limit: ${block.charLimit}`,
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
