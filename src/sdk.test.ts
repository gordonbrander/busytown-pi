import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clientOf } from "./sdk.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const createTempDbPath = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-test-"));
  return path.join(dir, "events.db");
};

describe("SDK clientOf", () => {
  it("publish writes events readable by subscribe", async () => {
    const dbPath = createTempDbPath();
    const producer = clientOf({ id: "producer", dbPath });
    const consumer = clientOf({ id: "consumer", dbPath });

    const published = producer.publish("test.hello", { msg: "hi" });
    assert.equal(published.type, "test.hello");
    assert.deepEqual(published.payload, { msg: "hi" });

    const events: (typeof published)[] = [];
    for await (const event of consumer.subscribe({
      listen: ["test.*"],
      pollInterval: 10,
    })) {
      events.push(event);
      if (events.length >= 1) break;
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "test.hello");
    assert.deepEqual(events[0].payload, { msg: "hi" });
  });

  it("subscribe respects listen patterns", async () => {
    const dbPath = createTempDbPath();
    const producer = clientOf({ id: "producer", dbPath });
    const consumer = clientOf({ id: "consumer", dbPath });

    producer.publish("task.created", {});
    producer.publish("log.info", {});
    producer.publish("task.updated", {});

    const events: { type: string }[] = [];
    for await (const event of consumer.subscribe({
      listen: ["task.*"],
      pollInterval: 10,
    })) {
      events.push(event);
      if (events.length >= 2) break;
    }

    assert.equal(events.length, 2);
    assert.equal(events[0].type, "task.created");
    assert.equal(events[1].type, "task.updated");
  });

  it("subscribe respects ignoreSelf", async () => {
    const dbPath = createTempDbPath();
    const client = clientOf({ id: "agent-a", dbPath });
    const other = clientOf({ id: "agent-b", dbPath });

    client.publish("test.event", { from: "self" });
    other.publish("test.event", { from: "other" });

    const events: { type: string; payload: unknown }[] = [];
    for await (const event of client.subscribe({
      listen: ["test.*"],
      ignoreSelf: true,
      pollInterval: 10,
    })) {
      events.push(event);
      if (events.length >= 1) break;
    }

    assert.equal(events.length, 1);
    assert.deepEqual(events[0].payload, { from: "other" });
  });

  it("subscribe with ignoreSelf=false yields own events", async () => {
    const dbPath = createTempDbPath();
    const client = clientOf({ id: "agent-a", dbPath });

    client.publish("test.event", { from: "self" });

    const events: { type: string }[] = [];
    for await (const event of client.subscribe({
      listen: ["test.*"],
      ignoreSelf: false,
      pollInterval: 10,
    })) {
      events.push(event);
      if (events.length >= 1) break;
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "test.event");
  });

  it("claim prevents duplicate processing", () => {
    const dbPath = createTempDbPath();
    const clientA = clientOf({ id: "agent-a", dbPath });
    const clientB = clientOf({ id: "agent-b", dbPath });

    const event = clientA.publish("task.do", {});

    const claimedA = clientA.claim(event.id);
    const claimedB = clientB.claim(event.id);

    assert.equal(claimedA, true);
    assert.equal(claimedB, false);
  });

  it("cursor advances across subscribe iterables", async () => {
    const dbPath = createTempDbPath();
    const producer = clientOf({ id: "producer", dbPath });
    const consumer = clientOf({ id: "consumer", dbPath });

    producer.publish("event.first", {});
    producer.publish("event.second", {});

    // First subscribe: consume one event
    for await (const event of consumer.subscribe({
      listen: ["event.*"],
      pollInterval: 10,
    })) {
      assert.equal(event.type, "event.first");
      break;
    }

    // Second subscribe: should start after the consumed event
    for await (const event of consumer.subscribe({
      listen: ["event.*"],
      pollInterval: 10,
    })) {
      assert.equal(event.type, "event.second");
      break;
    }
  });
});
