import * as fs from "node:fs";
import * as path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogRecord = {
  time: number;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
};

/** Create a log record from level, message, context, and data */
export const logRecordOf = (
  level: LogLevel,
  msg: string,
  context?: Record<string, unknown>,
  data?: Record<string, unknown>,
): LogRecord => {
  return { time: Date.now(), level, msg, ...context, ...data };
};

export type LogDriver = (record: LogRecord) => void;

export const consoleJsonLogDriverOf = (): LogDriver => (record: LogRecord) => {
  switch (record.level) {
    case "debug":
      console.debug(JSON.stringify(record));
      break;
    case "info":
      console.info(JSON.stringify(record));
      break;
    case "warn":
      console.warn(JSON.stringify(record));
      break;
    case "error":
      console.error(JSON.stringify(record));
      break;
  }
};

/** Create a log driver that appends a JSON line to a file per call.
 * Creates parent directories if they don't exist. */
export const fileLogDriverOf = (logPath: string): LogDriver => {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  return (record: LogRecord) => {
    fs.appendFileSync(logPath, JSON.stringify(record) + "\n");
  };
};

/** Get the log level index. This lets us decide which log levels to log. */
const logLevelToIndex = (level: LogLevel): number => {
  switch (level) {
    case "debug":
      return 0;
    case "info":
      return 1;
    case "warn":
      return 2;
    case "error":
      return 3;
  }
};

export type LogLevelFn = () => LogLevel;

export const levelOf = (level?: LogLevel | LogLevelFn): LogLevelFn => {
  switch (typeof level) {
    case "function":
      return level as LogLevelFn;
    case "string":
      return () => level as LogLevel;
    default:
      return () => "debug";
  }
};

/** Construct and log a record using the given drivers and level function. */
const logWith = (
  drivers: LogDriver[],
  getLoggerLevel: () => LogLevel,
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
  data?: Record<string, unknown>,
): void => {
  if (logLevelToIndex(level) < logLevelToIndex(getLoggerLevel())) return;
  const record = logRecordOf(level, message, context, data);
  for (const driver of drivers) driver(record);
};

export type LoggerConfig = {
  level?: LogLevel | LogLevelFn;
  drivers?: LogDriver[];
};

export type Logger = {
  debug: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
};

/** Creates a JSON logger that mixes in the given context into log entries. */
export const loggerOf = (
  context: Record<string, unknown> = {},
  { level, drivers = [consoleJsonLogDriverOf()] }: LoggerConfig = {},
): Logger => {
  const getLoggerLevel = levelOf(level);
  return {
    debug: (message, data) =>
      logWith(drivers, getLoggerLevel, "debug", message, context, data),
    info: (message, data) =>
      logWith(drivers, getLoggerLevel, "info", message, context, data),
    warn: (message, data) =>
      logWith(drivers, getLoggerLevel, "warn", message, context, data),
    error: (message, data) =>
      logWith(drivers, getLoggerLevel, "error", message, context, data),
  };
};

export const logger = loggerOf();
