/**
 * Split a raw command string into an argv-style token array.
 * Handles empty/blank input gracefully, returning [].
 */
export const shellSplit = (raw: string): string[] =>
  (raw ?? "").trim().split(/\s+/).filter(Boolean);

export const shellEscape = (value: string): string =>
  "'" + value.replace(/'/g, "'\\''") + "'";
