export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
};

const jsonLogOf = (
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
  data?: Record<string, unknown>,
): string => {
  const entry = { timestamp: Date.now(), level, message, ...context, ...data };
  return JSON.stringify(entry);
};

/** Creates a JSON logger that mixes in the given context into log entries. */
export const loggerOf = (context: Record<string, unknown> = {}): Logger => ({
  debug: (message, data) =>
    console.debug(jsonLogOf("debug", message, context, data)),
  info: (message, data) =>
    console.log(jsonLogOf("info", message, context, data)),
  warn: (message, data) =>
    console.warn(jsonLogOf("warn", message, context, data)),
  error: (message, data) =>
    console.error(jsonLogOf("error", message, context, data)),
});

export const logger = loggerOf();
