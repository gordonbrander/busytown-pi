import * as fs from "node:fs";

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

/** Create a log driver that appends a JSON line to a file per call. */
export const fileLogDriverOf =
  (logPath: string): LogDriver =>
  (record: LogRecord) => {
    fs.appendFileSync(logPath, JSON.stringify(record) + "\n");
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
    default:
      throw new Error(`Invalid log level: ${level}`);
  }
};

export type LoggerConfig = {
  level?: LogLevel;
  drivers?: LogDriver[];
};

class Logger {
  #context: Record<string, unknown>;
  #drivers: LogDriver[];
  level: LogLevel;

  constructor(context: Record<string, unknown>, config: LoggerConfig = {}) {
    this.#context = context;
    this.#drivers = config.drivers ?? [consoleJsonLogDriverOf()];
    this.level = config.level ?? "debug";
  }

  #shouldLog(level: LogLevel): boolean {
    return logLevelToIndex(level) >= logLevelToIndex(this.level);
  }

  #log(level: LogLevel, message: string, data?: Record<string, unknown>) {
    if (!this.#shouldLog(level)) return;
    for (const driver of this.#drivers) {
      driver(logRecordOf(level, message, this.#context, data));
    }
  }

  debug(message: string, data?: Record<string, unknown>) {
    this.#log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>) {
    this.#log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>) {
    this.#log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>) {
    this.#log("error", message, data);
  }
}

/** Creates a JSON logger that mixes in the given context into log entries. */
export const loggerOf = (
  context: Record<string, unknown> = {},
  config: LoggerConfig = {},
): Logger => new Logger(context, config);

export const logger = loggerOf();
