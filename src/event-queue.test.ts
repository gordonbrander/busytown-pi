import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  claimEvent,
  compactEvents,
  getAllCursors,
  getClaimant,
  getCursor,
  getEventsSince,
  getLatestEventId,
  getNextEvent,
  getOrCreateCursor,
  openDb,
  pollEvents,
  pullNextMatchingEvent,
  setEpoch,
  pushEvent,
  updateCursor,
} from "./event-queue.ts";

const createTestDb = (): DatabaseSync => openDb(":memory:");

describe("pushEvent", () => {
  it("inserts an event and returns it with an id", () => {
    const db = createTestDb();
    const event = pushEvent(db, "agent-1", "plan.request", { key: "val" });
    assert.equal(event.type, "plan.request");
    assert.equal(event.agent_id, "agent-1");
    assert.deepEqual(event.payload, { key: "val" });
    assert.equal(typeof event.id, "number");
    assert.equal(typeof event.timestamp, "number");
    db.close();
  });

  it("auto-increments event ids", () => {
    const db = createTestDb();
    const e1 = pushEvent(db, "w", "a");
    const e2 = pushEvent(db, "w", "b");
    assert.ok(e2.id > e1.id);
    db.close();
  });

  it("defaults payload to empty object", () => {
    const db = createTestDb();
    const event = pushEvent(db, "w", "test");
    assert.deepEqual(event.payload, {});
    db.close();
  });
});

describe("getCursor / updateCursor", () => {
  it("returns 0 for unknown agent", () => {
    const db = createTestDb();
    assert.equal(getCursor(db, "unknown"), 0);
    db.close();
  });

  it("updates and retrieves cursor", () => {
    const db = createTestDb();
    updateCursor(db, "w1", 42);
    assert.equal(getCursor(db, "w1"), 42);
    db.close();
  });

  it("upserts cursor value", () => {
    const db = createTestDb();
    updateCursor(db, "w1", 10);
    updateCursor(db, "w1", 20);
    assert.equal(getCursor(db, "w1"), 20);
    db.close();
  });
});

describe("getOrCreateCursor", () => {
  it("creates cursor at first event for new agent", () => {
    const db = createTestDb();
    const cursor = getOrCreateCursor(db, "new-agent");
    // Should have pushed a sys.cursor.create event and set cursor to that id
    assert.ok(cursor > 0);
    assert.equal(getCursor(db, "new-agent"), cursor);
    db.close();
  });

  it("returns existing cursor for known agent", () => {
    const db = createTestDb();
    updateCursor(db, "w1", 5);
    assert.equal(getOrCreateCursor(db, "w1"), 5);
    db.close();
  });
});

describe("getEventsSince", () => {
  it("returns events after sinceId", () => {
    const db = createTestDb();
    const e1 = pushEvent(db, "w", "a");
    const e2 = pushEvent(db, "w", "b");
    const e3 = pushEvent(db, "w", "c");

    const events = getEventsSince(db, { sinceId: e1.id });
    assert.equal(events.length, 2);
    assert.equal(events[0].id, e2.id);
    assert.equal(events[1].id, e3.id);
    db.close();
  });

  it("respects limit", () => {
    const db = createTestDb();
    pushEvent(db, "w", "a");
    pushEvent(db, "w", "b");
    pushEvent(db, "w", "c");

    const events = getEventsSince(db, { limit: 2 });
    assert.equal(events.length, 2);
    db.close();
  });

  it("filters by omitAgentId", () => {
    const db = createTestDb();
    pushEvent(db, "w1", "a");
    pushEvent(db, "w2", "b");
    pushEvent(db, "w1", "c");

    const events = getEventsSince(db, { omitAgentId: "w1" });
    assert.equal(events.length, 1);
    assert.equal(events[0].agent_id, "w2");
    db.close();
  });

  it("filters by filterAgentId", () => {
    const db = createTestDb();
    pushEvent(db, "w1", "a");
    pushEvent(db, "w2", "b");
    pushEvent(db, "w1", "c");

    const events = getEventsSince(db, { filterAgentId: "w1" });
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.agent_id === "w1"));
    db.close();
  });

  it("filters by filterType", () => {
    const db = createTestDb();
    pushEvent(db, "w", "plan.request");
    pushEvent(db, "w", "code.request");
    pushEvent(db, "w", "plan.request");

    const events = getEventsSince(db, { filterType: "plan.request" });
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.type === "plan.request"));
    db.close();
  });

  it("does not filter when filterType is *", () => {
    const db = createTestDb();
    pushEvent(db, "w", "a");
    pushEvent(db, "w", "b");

    const events = getEventsSince(db, { filterType: "*" });
    assert.equal(events.length, 2);
    db.close();
  });

  it("tail returns last N events in order", () => {
    const db = createTestDb();
    pushEvent(db, "w", "a");
    pushEvent(db, "w", "b");
    const e3 = pushEvent(db, "w", "c");
    const e4 = pushEvent(db, "w", "d");

    const events = getEventsSince(db, { tail: 2 });
    assert.equal(events.length, 2);
    assert.equal(events[0].id, e3.id);
    assert.equal(events[1].id, e4.id);
    db.close();
  });

  it("returns empty array when no events", () => {
    const db = createTestDb();
    const events = getEventsSince(db);
    assert.deepEqual(events, []);
    db.close();
  });
});

describe("getNextEvent", () => {
  it("returns next event after sinceId", () => {
    const db = createTestDb();
    const e1 = pushEvent(db, "w", "a");
    const e2 = pushEvent(db, "w", "b");

    const next = getNextEvent(db, e1.id);
    assert.equal(next?.id, e2.id);
    db.close();
  });

  it("returns undefined when no more events", () => {
    const db = createTestDb();
    const e1 = pushEvent(db, "w", "a");

    const next = getNextEvent(db, e1.id);
    assert.equal(next, undefined);
    db.close();
  });
});

describe("pullNextMatchingEvent", () => {
  // Helper: initialize cursor so it exists before pushing test events.
  // getOrCreateCursor pushes a sys.cursor.create event, so calling it first
  // ensures the cursor starts before any test events.
  const initPuller = (db: DatabaseSync, id: string): void => {
    getOrCreateCursor(db, id);
  };

  it("returns the first event matching the filter", () => {
    const db = createTestDb();
    initPuller(db, "puller");
    pushEvent(db, "w", "a");
    const e2 = pushEvent(db, "w", "b");

    const result = pullNextMatchingEvent(db, "puller", (e) => e.type === "b");
    assert.equal(result?.id, e2.id);
    assert.equal(result?.type, "b");
    db.close();
  });

  it("skips events that don't match the filter", () => {
    const db = createTestDb();
    initPuller(db, "puller");
    pushEvent(db, "w", "a");
    pushEvent(db, "w", "a");
    const e3 = pushEvent(db, "w", "b");

    const result = pullNextMatchingEvent(db, "puller", (e) => e.type === "b");
    assert.equal(result?.id, e3.id);
    db.close();
  });

  it("returns undefined when no events match", () => {
    const db = createTestDb();
    initPuller(db, "puller");
    pushEvent(db, "w", "a");
    pushEvent(db, "w", "a");

    const result = pullNextMatchingEvent(db, "puller", (e) => e.type === "z");
    assert.equal(result, undefined);
    db.close();
  });

  it("returns undefined when queue is empty", () => {
    const db = createTestDb();
    const result = pullNextMatchingEvent(db, "puller", () => true);
    assert.equal(result, undefined);
    db.close();
  });

  it("advances cursor past skipped and matched events", () => {
    const db = createTestDb();
    initPuller(db, "puller");
    pushEvent(db, "w", "a");
    pushEvent(db, "w", "b");
    pushEvent(db, "w", "c");

    pullNextMatchingEvent(db, "puller", (e) => e.type === "b");

    // Cursor should be at e2, so next pull starts after it
    const result = pullNextMatchingEvent(db, "puller", (e) => e.type === "c");
    assert.equal(result?.type, "c");
    db.close();
  });

  it("skips claimed events", () => {
    const db = createTestDb();
    initPuller(db, "puller");
    const e1 = pushEvent(db, "w", "task");
    const e2 = pushEvent(db, "w", "task");

    claimEvent(db, "other-agent", e1.id);

    const result = pullNextMatchingEvent(
      db,
      "puller",
      (e) => e.type === "task",
    );
    assert.equal(result?.id, e2.id);
    db.close();
  });

  it("advances cursor past all events when none match", () => {
    const db = createTestDb();
    initPuller(db, "puller");
    pushEvent(db, "w", "a");
    pushEvent(db, "w", "b");

    pullNextMatchingEvent(db, "puller", () => false);

    // New event after exhausting the queue should be found
    const e3 = pushEvent(db, "w", "c");
    const result = pullNextMatchingEvent(db, "puller", () => true);
    assert.equal(result?.id, e3.id);
    db.close();
  });
});

describe("pollEvents", () => {
  it("returns new events and advances cursor", () => {
    const db = createTestDb();
    pushEvent(db, "w1", "a");
    pushEvent(db, "w1", "b");

    // First poll creates cursor, which itself creates an event
    const _events1 = pollEvents(db, "poller");
    // The cursor.create event is at or after the existing events
    // so the cursor is set past all events

    // Push more events after the cursor
    pushEvent(db, "w1", "c");
    pushEvent(db, "w1", "d");

    const events2 = pollEvents(db, "poller");
    assert.equal(events2.length, 2);
    assert.equal(events2[0].type, "c");
    assert.equal(events2[1].type, "d");
    db.close();
  });

  it("returns empty array when no new events", () => {
    const db = createTestDb();
    // Initialize cursor
    pollEvents(db, "poller");

    const events = pollEvents(db, "poller");
    assert.deepEqual(events, []);
    db.close();
  });
});

describe("claimEvent / getClaimant", () => {
  it("claims an event successfully", () => {
    const db = createTestDb();
    const event = pushEvent(db, "w", "task");

    const claimed = claimEvent(db, "claimer", event.id);
    assert.equal(claimed, true);
    db.close();
  });

  it("returns false when event already claimed by another agent", () => {
    const db = createTestDb();
    const event = pushEvent(db, "w", "task");

    claimEvent(db, "claimer-1", event.id);
    const claimed = claimEvent(db, "claimer-2", event.id);
    assert.equal(claimed, false);
    db.close();
  });

  it("returns true when same agent claims again", () => {
    const db = createTestDb();
    const event = pushEvent(db, "w", "task");

    claimEvent(db, "claimer", event.id);
    const claimed = claimEvent(db, "claimer", event.id);
    assert.equal(claimed, true);
    db.close();
  });

  it("getClaimant returns claimant info", () => {
    const db = createTestDb();
    const event = pushEvent(db, "w", "task");

    claimEvent(db, "claimer", event.id);
    const claimant = getClaimant(db, event.id);
    assert.equal(claimant?.agent_id, "claimer");
    assert.equal(typeof claimant?.claimed_at, "number");
    db.close();
  });

  it("getClaimant returns undefined for unclaimed event", () => {
    const db = createTestDb();
    const event = pushEvent(db, "w", "task");

    const claimant = getClaimant(db, event.id);
    assert.equal(claimant, undefined);
    db.close();
  });
});

describe("getLatestEventId", () => {
  it("returns 0 for an empty db", () => {
    const db = createTestDb();
    assert.equal(getLatestEventId(db), 0);
    db.close();
  });

  it("returns the max event id", () => {
    const db = createTestDb();
    pushEvent(db, "w", "a");
    pushEvent(db, "w", "b");
    const last = pushEvent(db, "w", "c");
    assert.equal(getLatestEventId(db), last.id);
    db.close();
  });
});

describe("getAllCursors", () => {
  it("returns an empty array when no cursors exist", () => {
    const db = createTestDb();
    assert.deepEqual(getAllCursors(db), []);
    db.close();
  });

  it("returns all cursor rows sorted by agent_id", () => {
    const db = createTestDb();
    updateCursor(db, "beta", 10);
    updateCursor(db, "alpha", 5);
    const cursors = getAllCursors(db);
    assert.equal(cursors.length, 2);
    assert.equal(cursors[0].agent_id, "alpha");
    assert.equal(cursors[0].since, 5);
    assert.equal(cursors[1].agent_id, "beta");
    assert.equal(cursors[1].since, 10);
    db.close();
  });
});

describe("setEpoch", () => {
  it("pushes a sys.epoch event and advances all cursors to its id", () => {
    const db = createTestDb();
    pushEvent(db, "w", "a");
    pushEvent(db, "w", "b");
    updateCursor(db, "agent-1", 1);
    updateCursor(db, "agent-2", 1);

    const { event, advancedAgentIds } = setEpoch(db);

    assert.equal(event.type, "sys.epoch");
    assert.equal(event.agent_id, "sys");
    assert.deepEqual(advancedAgentIds.sort(), ["agent-1", "agent-2"]);
    assert.equal(getCursor(db, "agent-1"), event.id);
    assert.equal(getCursor(db, "agent-2"), event.id);
    db.close();
  });

  it("pushes the event even when no cursors exist", () => {
    const db = createTestDb();
    const { event, advancedAgentIds } = setEpoch(db);
    assert.equal(event.type, "sys.epoch");
    assert.deepEqual(advancedAgentIds, []);
    assert.equal(getLatestEventId(db), event.id);
    db.close();
  });
});

describe("compactEvents", () => {
  it("deletes events with id strictly less than the minimum cursor", () => {
    const db = createTestDb();
    const events = [
      pushEvent(db, "w", "a"),
      pushEvent(db, "w", "b"),
      pushEvent(db, "w", "c"),
      pushEvent(db, "w", "d"),
    ];
    updateCursor(db, "fast", events[3].id);
    updateCursor(db, "slow", events[2].id);

    const result = compactEvents(db);

    assert.equal(result.minCursor, events[2].id);
    assert.equal(result.deletedEvents, 2);
    assert.equal(result.latestId, events[3].id);
    const remaining = getEventsSince(db, { sinceId: 0, limit: 100 });
    assert.deepEqual(
      remaining.map((e) => e.id),
      [events[2].id, events[3].id],
    );
    db.close();
  });

  it("is a no-op when no cursors exist", () => {
    const db = createTestDb();
    pushEvent(db, "w", "a");
    pushEvent(db, "w", "b");

    const result = compactEvents(db);

    assert.equal(result.deletedEvents, 0);
    assert.equal(result.deletedClaims, 0);
    assert.equal(result.minCursor, 0);
    assert.deepEqual(result.laggingAgents, []);
    assert.equal(getEventsSince(db, { sinceId: 0, limit: 100 }).length, 2);
    db.close();
  });

  it("also deletes claims for removed events", () => {
    const db = createTestDb();
    const e1 = pushEvent(db, "w", "a");
    const e2 = pushEvent(db, "w", "b");
    const e3 = pushEvent(db, "w", "c");
    claimEvent(db, "claimer", e1.id);
    claimEvent(db, "claimer", e2.id);
    updateCursor(db, "agent", e3.id);

    const result = compactEvents(db);

    assert.ok(result.deletedClaims >= 2);
    assert.equal(getClaimant(db, e1.id), undefined);
    assert.equal(getClaimant(db, e2.id), undefined);
    db.close();
  });

  it("warns per agent whose cursor is more than threshold behind tail", () => {
    const db = createTestDb();
    for (let i = 0; i < 150; i++) {
      pushEvent(db, "w", "tick");
    }
    const latest = getLatestEventId(db);
    updateCursor(db, "slow", 10);
    updateCursor(db, "medium", latest - 50);
    updateCursor(db, "fast", latest);

    const result = compactEvents(db, 100);

    const ids = result.laggingAgents.map((a) => a.agent_id);
    assert.deepEqual(ids, ["slow"]);
    assert.equal(result.laggingAgents[0].behind, latest - 10);
    db.close();
  });

  it("produces no warnings when all cursors are within threshold", () => {
    const db = createTestDb();
    for (let i = 0; i < 50; i++) {
      pushEvent(db, "w", "tick");
    }
    const latest = getLatestEventId(db);
    updateCursor(db, "a", latest - 5);
    updateCursor(db, "b", latest);

    const result = compactEvents(db, 100);

    assert.deepEqual(result.laggingAgents, []);
    db.close();
  });
});
