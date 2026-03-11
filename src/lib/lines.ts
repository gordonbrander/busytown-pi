/** Split lines of a string */
export const split = (str: string): string[] => {
  return str.split("\n");
};

/** Join lines into a string */
export const join = (lines: string[]): string => {
  return lines.join("\n");
};

export const indent = (lines: string[], prefix: string = "  "): string[] => {
  return lines.map((line) => {
    if (line.trim().length === 0) {
      return line;
    }
    return prefix + line;
  });
}
