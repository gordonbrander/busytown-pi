export const shellEscape = (value: string): string =>
  "'" + value.replace(/'/g, "'\\''") + "'"
