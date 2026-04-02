import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loggerOf, type LogDriver } from "./json-logger.ts";

/** Create a mock driver that captures log output by level. */
const mockDriver = (): LogDriver & { calls: Record<string, string[]> } => {
  const calls: Record<string, string[]> = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  return {
    calls,
    debug: (msg: string) => calls.debug.push(msg),
    info: (msg: string) => calls.info.push(msg),
    warn: (msg: string) => calls.warn.push(msg),
    error: (msg: string) => calls.error.push(msg),
  };
};

describe("loggerOf", () => {
  it("logs JSON with timestamp, level, and message", () => {
    const driver = mockDriver();
    const logger = loggerOf({}, driver);

    logger.info("hello");

    assert.equal(driver.calls.info.length, 1);
    const entry = JSON.parse(driver.calls.info[0]);
    assert.equal(entry.level, "info");
    assert.equal(entry.message, "hello");
    assert.equal(typeof entry.timestamp, "number");
  });

  it("routes each level to the correct driver method", () => {
    const driver = mockDriver();
    const logger = loggerOf({}, driver);

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    assert.equal(driver.calls.debug.length, 1);
    assert.equal(driver.calls.info.length, 1);
    assert.equal(driver.calls.warn.length, 1);
    assert.equal(driver.calls.error.length, 1);

    assert.equal(JSON.parse(driver.calls.debug[0]).level, "debug");
    assert.equal(JSON.parse(driver.calls.warn[0]).level, "warn");
    assert.equal(JSON.parse(driver.calls.error[0]).level, "error");
  });

  it("mixes context into every log entry", () => {
    const driver = mockDriver();
    const logger = loggerOf({ service: "worker", pid: 42 }, driver);

    logger.info("started");

    const entry = JSON.parse(driver.calls.info[0]);
    assert.equal(entry.service, "worker");
    assert.equal(entry.pid, 42);
  });

  it("mixes per-call data into the log entry", () => {
    const driver = mockDriver();
    const logger = loggerOf({}, driver);

    logger.info("event", { eventId: "abc" });

    const entry = JSON.parse(driver.calls.info[0]);
    assert.equal(entry.eventId, "abc");
  });

  it("merges both context and data", () => {
    const driver = mockDriver();
    const logger = loggerOf({ service: "api" }, driver);

    logger.warn("slow", { latency: 500 });

    const entry = JSON.parse(driver.calls.warn[0]);
    assert.equal(entry.service, "api");
    assert.equal(entry.latency, 500);
    assert.equal(entry.message, "slow");
  });

  it("per-call data overrides context for same key", () => {
    const driver = mockDriver();
    const logger = loggerOf({ requestId: "ctx" }, driver);

    logger.info("override", { requestId: "call" });

    const entry = JSON.parse(driver.calls.info[0]);
    assert.equal(entry.requestId, "call");
  });

  it("works without data argument", () => {
    const driver = mockDriver();
    const logger = loggerOf({ env: "test" }, driver);

    logger.debug("no data");

    const entry = JSON.parse(driver.calls.debug[0]);
    assert.equal(entry.message, "no data");
    assert.equal(entry.env, "test");
  });
});
