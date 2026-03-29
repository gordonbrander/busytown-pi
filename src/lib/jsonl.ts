// Parse a single line of JSONL (JSON Lines)
export const parseJsonLine = (line: string): unknown => {
  return JSON.parse(line.trim());
};
