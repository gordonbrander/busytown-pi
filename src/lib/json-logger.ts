export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogDriver = {
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

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
export const loggerOf = (
  context: Record<string, unknown> = {},
  driver: LogDriver = console
): Logger => ({
  debug: (message, data) =>
    driver.debug(jsonLogOf("debug", message, context, data)),
  info: (message, data) =>
    driver.info(jsonLogOf("info", message, context, data)),
  warn: (message, data) =>
    driver.warn(jsonLogOf("warn", message, context, data)),
  error: (message, data) =>
    driver.error(jsonLogOf("error", message, context, data)),
});

export const logger = loggerOf();
