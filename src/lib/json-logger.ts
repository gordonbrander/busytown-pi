type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
};

const log = (
  level: LogLevel,
  msg: string,
  data?: Record<string, unknown>,
): void => {
  const entry = { timestamp: Date.now(), level, msg, ...data };
  console.log(JSON.stringify(entry));
};

export const logger: Logger = {
  debug: (msg, data) => log("debug", msg, data),
  info: (msg, data) => log("info", msg, data),
  warn: (msg, data) => log("warn", msg, data),
  error: (msg, data) => log("error", msg, data),
};
