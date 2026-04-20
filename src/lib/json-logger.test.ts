import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  fileLogDriverOf,
  type LogDriver,
  type LogRecord,
  loggerOf,
} from "./json-logger.ts";

/** Create a mock driver that captures every log record. */
const mockDriver = (): LogDriver & { records: LogRecord[] } => {
  const records: LogRecord[] = [];
  const driver: LogDriver = (record) => {
    records.push(record);
  };
  return Object.assign(driver, { records });
};

describe("loggerOf", () => {
  it("emits records with time, level, and msg", () => {
    const driver = mockDriver();
    const logger = loggerOf({}, { drivers: [driver] });

    logger.info("hello");

    assert.equal(driver.records.length, 1);
    const entry = driver.records[0];
    assert.equal(entry.level, "info");
    assert.equal(entry.msg, "hello");
    assert.equal(typeof entry.time, "number");
  });

  it("routes each level through the driver", () => {
    const driver = mockDriver();
    const logger = loggerOf({}, { drivers: [driver] });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    assert.deepEqual(
      driver.records.map((r) => r.level),
      ["debug", "info", "warn", "error"],
    );
  });

  it("mixes context into every log entry", () => {
    const driver = mockDriver();
    const logger = loggerOf(
      { service: "worker", pid: 42 },
      { drivers: [driver] },
    );

    logger.info("started");

    const entry = driver.records[0];
    assert.equal(entry.service, "worker");
    assert.equal(entry.pid, 42);
  });

  it("mixes per-call data into the log entry", () => {
    const driver = mockDriver();
    const logger = loggerOf({}, { drivers: [driver] });

    logger.info("event", { eventId: "abc" });

    assert.equal(driver.records[0].eventId, "abc");
  });

  it("merges both context and data", () => {
    const driver = mockDriver();
    const logger = loggerOf({ service: "api" }, { drivers: [driver] });

    logger.warn("slow", { latency: 500 });

    const entry = driver.records[0];
    assert.equal(entry.service, "api");
    assert.equal(entry.latency, 500);
    assert.equal(entry.msg, "slow");
  });

  it("per-call data overrides context for same key", () => {
    const driver = mockDriver();
    const logger = loggerOf({ requestId: "ctx" }, { drivers: [driver] });

    logger.info("override", { requestId: "call" });

    assert.equal(driver.records[0].requestId, "call");
  });

  it("works without data argument", () => {
    const driver = mockDriver();
    const logger = loggerOf({ env: "test" }, { drivers: [driver] });

    logger.debug("no data");

    const entry = driver.records[0];
    assert.equal(entry.msg, "no data");
    assert.equal(entry.env, "test");
  });

  it("filters records below the configured level", () => {
    const driver = mockDriver();
    const logger = loggerOf({}, { drivers: [driver], level: "warn" });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    assert.deepEqual(
      driver.records.map((r) => r.level),
      ["warn", "error"],
    );
  });

  it("fans out to multiple drivers", () => {
    const a = mockDriver();
    const b = mockDriver();
    const logger = loggerOf({}, { drivers: [a, b] });

    logger.info("hi");

    assert.equal(a.records.length, 1);
    assert.equal(b.records.length, 1);
  });

  it("resolves level via thunk on every call (late binding)", () => {
    const driver = mockDriver();
    let currentLevel: "debug" | "info" | "warn" | "error" = "warn";
    const logger = loggerOf(
      {},
      { drivers: [driver], level: () => currentLevel },
    );

    logger.info("filtered");
    assert.equal(driver.records.length, 0);

    currentLevel = "debug";
    logger.info("passes");
    assert.equal(driver.records.length, 1);
    assert.equal(driver.records[0].msg, "passes");
  });
});

describe("fileLogDriverOf", () => {
  it("appends JSON lines to the file", () => {
    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "json-logger-")),
      "log.ndjson",
    );
    const driver = fileLogDriverOf(logPath);
    const logger = loggerOf({ service: "x" }, { drivers: [driver] });

    logger.info("first");
    logger.warn("second", { code: 7 });

    const lines = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    assert.equal(lines.length, 2);

    const a = JSON.parse(lines[0]);
    assert.equal(a.msg, "first");
    assert.equal(a.level, "info");
    assert.equal(a.service, "x");

    const b = JSON.parse(lines[1]);
    assert.equal(b.msg, "second");
    assert.equal(b.code, 7);
  });
});
