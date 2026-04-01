import { parseSlug } from "../lib/slug.ts";
import { truncate, type TruncationReceipt } from "../lib/truncate.ts";

export type MemoryBlock = {
  description: string;
  value: string;
  charLimit: number;
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
