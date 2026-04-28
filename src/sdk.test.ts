import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clientOf, throwIfOrphaned } from "./sdk.ts";
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

  it("subscribe without claim is multicast: two subscribers both see each event", async () => {
    const dbPath = createTempDbPath();
    const producer = clientOf({ id: "producer", dbPath });
    const consumerA = clientOf({ id: "consumer-a", dbPath });
    const consumerB = clientOf({ id: "consumer-b", dbPath });

    const published = producer.publish("multicast.msg", { n: 1 });

    const eventsA: { id: number }[] = [];
    for await (const event of consumerA.subscribe({
      listen: ["multicast.*"],
      pollInterval: 10,
    })) {
      eventsA.push(event);
      break;
    }

    const eventsB: { id: number }[] = [];
    for await (const event of consumerB.subscribe({
      listen: ["multicast.*"],
      pollInterval: 10,
    })) {
      eventsB.push(event);
      break;
    }

    assert.equal(eventsA[0].id, published.id);
    assert.equal(eventsB[0].id, published.id);
  });

  it("subscribe with claim:true partitions events between competing consumers", async () => {
    const dbPath = createTempDbPath();
    const producer = clientOf({ id: "producer", dbPath });
    const workerA = clientOf({ id: "worker-a", dbPath });
    const workerB = clientOf({ id: "worker-b", dbPath });

    const expectedCount = 3;
    producer.publish("work.do", { n: 1 });
    producer.publish("work.do", { n: 2 });
    producer.publish("work.do", { n: 3 });

    const aborter = new AbortController();
    const idsA: number[] = [];
    const idsB: number[] = [];

    const checkDone = (): void => {
      if (idsA.length + idsB.length >= expectedCount) aborter.abort();
    };
    // Safety net: if a regression makes one worker silently never yield,
    // make the test fail fast instead of hanging until the runner timeout.
    const safety = setTimeout(() => aborter.abort(), 1000);

    const runA = (async () => {
      for await (const event of workerA.subscribe({
        listen: ["work.*"],
        claim: true,
        pollInterval: 5,
        signal: aborter.signal,
      })) {
        idsA.push(event.id);
        checkDone();
      }
    })();

    const runB = (async () => {
      for await (const event of workerB.subscribe({
        listen: ["work.*"],
        claim: true,
        pollInterval: 5,
        signal: aborter.signal,
      })) {
        idsB.push(event.id);
        checkDone();
      }
    })();

    await Promise.all([runA, runB]);
    clearTimeout(safety);

    const union = [...idsA, ...idsB].sort((a, b) => a - b);
    const dedup = Array.from(new Set(union));
    assert.equal(union.length, expectedCount, "no event consumed twice");
    assert.equal(dedup.length, expectedCount, "no duplicate ids");
  });

  it("speculative claim() still works alongside a claim:true subscriber", async () => {
    const dbPath = createTempDbPath();
    const producer = clientOf({ id: "producer", dbPath });
    const observer = clientOf({ id: "observer", dbPath });
    const worker = clientOf({ id: "worker", dbPath });

    const event = producer.publish("speculative.task", {});

    // Observer pulls the event without claiming it.
    let observed: { id: number } | undefined;
    for await (const e of observer.subscribe({
      listen: ["speculative.*"],
      pollInterval: 5,
    })) {
      observed = e;
      break;
    }
    assert.equal(observed?.id, event.id);

    // Observer decides to take it via the explicit claim() call.
    const observerWon = observer.claim(event.id);
    assert.equal(observerWon, true);

    // A later claim:true subscriber should not see the now-claimed event.
    const aborter = new AbortController();
    const workerEvents: { id: number }[] = [];
    setTimeout(() => aborter.abort(), 50);
    for await (const e of worker.subscribe({
      listen: ["speculative.*"],
      claim: true,
      pollInterval: 5,
      signal: aborter.signal,
    })) {
      workerEvents.push(e);
    }
    assert.equal(workerEvents.length, 0);
  });

  it("subscribe throws when parentPid no longer matches process.ppid", async () => {
    const dbPath = createTempDbPath();
    const producer = clientOf({ id: "producer", dbPath });
    // Deliberately pick a parentPid that can't match process.ppid.
    const orphanedParentPid = process.ppid === 1 ? 2 : 1;
    const consumer = clientOf({
      id: "orphan-consumer",
      dbPath,
      parentPid: orphanedParentPid,
    });

    producer.publish("orphan.test", {});

    await assert.rejects(
      (async () => {
        for await (const _event of consumer.subscribe({
          listen: ["orphan.*"],
          pollInterval: 10,
        })) {
          // unreachable: check runs at top of loop, before pulling events
        }
      })(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          new RegExp(
            `expected parent pid ${orphanedParentPid}, got ${process.ppid}`,
          ),
        );
        return true;
      },
    );
  });

  it("subscribe never throws when parentPid is unset", async () => {
    const dbPath = createTempDbPath();
    const producer = clientOf({ id: "producer", dbPath });
    const consumer = clientOf({ id: "standalone", dbPath });

    producer.publish("standalone.test", {});

    for await (const event of consumer.subscribe({
      listen: ["standalone.*"],
      pollInterval: 10,
    })) {
      assert.equal(event.type, "standalone.test");
      break;
    }
  });

  it("throwIfOrphaned throws when injected getPpid differs", () => {
    assert.throws(
      () => throwIfOrphaned(100, () => 1),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /expected parent pid 100, got 1/);
        return true;
      },
    );
  });

  it("throwIfOrphaned returns when injected getPpid matches", () => {
    assert.doesNotThrow(() => throwIfOrphaned(100, () => 100));
  });

  it("publish threads cause through to correlation_id, causation_id, depth", () => {
    const dbPath = createTempDbPath();
    const client = clientOf({ id: "agent-a", dbPath });

    const root = client.publish("flow.start", {});
    assert.equal(root.depth, 0);
    assert.equal(root.correlation_id, undefined);
    assert.equal(root.causation_id, undefined);

    const child = client.publish("flow.step", { n: 1 }, root);
    assert.equal(child.causation_id, root.id);
    assert.equal(child.correlation_id, root.id);
    assert.equal(child.depth, 1);

    const grandchild = client.publish("flow.step", { n: 2 }, child);
    assert.equal(grandchild.causation_id, child.id);
    assert.equal(grandchild.correlation_id, root.id);
    assert.equal(grandchild.depth, 2);
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
