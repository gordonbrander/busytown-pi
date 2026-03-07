import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import {
  openDb,
  pushEvent,
  getCursor,
  updateCursor,
  getOrCreateCursor,
  getEventsSince,
  getNextEvent,
  pollEvents,
  claimEvent,
  getClaimant,
} from "./event-queue.ts"

const createTestDb = (): DatabaseSync => openDb(":memory:")

describe("pushEvent", () => {
  it("inserts an event and returns it with an id", () => {
    const db = createTestDb()
    const event = pushEvent(db, "worker-1", "plan.request", { key: "val" })
    assert.equal(event.type, "plan.request")
    assert.equal(event.worker_id, "worker-1")
    assert.deepEqual(event.payload, { key: "val" })
    assert.equal(typeof event.id, "number")
    assert.equal(typeof event.timestamp, "number")
    db.close()
  })

  it("auto-increments event ids", () => {
    const db = createTestDb()
    const e1 = pushEvent(db, "w", "a")
    const e2 = pushEvent(db, "w", "b")
    assert.ok(e2.id > e1.id)
    db.close()
  })

  it("defaults payload to empty object", () => {
    const db = createTestDb()
    const event = pushEvent(db, "w", "test")
    assert.deepEqual(event.payload, {})
    db.close()
  })
})

describe("getCursor / updateCursor", () => {
  it("returns 0 for unknown worker", () => {
    const db = createTestDb()
    assert.equal(getCursor(db, "unknown"), 0)
    db.close()
  })

  it("updates and retrieves cursor", () => {
    const db = createTestDb()
    updateCursor(db, "w1", 42)
    assert.equal(getCursor(db, "w1"), 42)
    db.close()
  })

  it("upserts cursor value", () => {
    const db = createTestDb()
    updateCursor(db, "w1", 10)
    updateCursor(db, "w1", 20)
    assert.equal(getCursor(db, "w1"), 20)
    db.close()
  })
})

describe("getOrCreateCursor", () => {
  it("creates cursor at first event for new worker", () => {
    const db = createTestDb()
    const cursor = getOrCreateCursor(db, "new-worker")
    // Should have pushed a sys.cursor.create event and set cursor to that id
    assert.ok(cursor > 0)
    assert.equal(getCursor(db, "new-worker"), cursor)
    db.close()
  })

  it("returns existing cursor for known worker", () => {
    const db = createTestDb()
    updateCursor(db, "w1", 5)
    assert.equal(getOrCreateCursor(db, "w1"), 5)
    db.close()
  })
})

describe("getEventsSince", () => {
  it("returns events after sinceId", () => {
    const db = createTestDb()
    const e1 = pushEvent(db, "w", "a")
    const e2 = pushEvent(db, "w", "b")
    const e3 = pushEvent(db, "w", "c")

    const events = getEventsSince(db, { sinceId: e1.id })
    assert.equal(events.length, 2)
    assert.equal(events[0].id, e2.id)
    assert.equal(events[1].id, e3.id)
    db.close()
  })

  it("respects limit", () => {
    const db = createTestDb()
    pushEvent(db, "w", "a")
    pushEvent(db, "w", "b")
    pushEvent(db, "w", "c")

    const events = getEventsSince(db, { limit: 2 })
    assert.equal(events.length, 2)
    db.close()
  })

  it("filters by omitWorkerId", () => {
    const db = createTestDb()
    pushEvent(db, "w1", "a")
    pushEvent(db, "w2", "b")
    pushEvent(db, "w1", "c")

    const events = getEventsSince(db, { omitWorkerId: "w1" })
    assert.equal(events.length, 1)
    assert.equal(events[0].worker_id, "w2")
    db.close()
  })

  it("filters by filterWorkerId", () => {
    const db = createTestDb()
    pushEvent(db, "w1", "a")
    pushEvent(db, "w2", "b")
    pushEvent(db, "w1", "c")

    const events = getEventsSince(db, { filterWorkerId: "w1" })
    assert.equal(events.length, 2)
    assert.ok(events.every((e) => e.worker_id === "w1"))
    db.close()
  })

  it("filters by filterType", () => {
    const db = createTestDb()
    pushEvent(db, "w", "plan.request")
    pushEvent(db, "w", "code.request")
    pushEvent(db, "w", "plan.request")

    const events = getEventsSince(db, { filterType: "plan.request" })
    assert.equal(events.length, 2)
    assert.ok(events.every((e) => e.type === "plan.request"))
    db.close()
  })

  it("does not filter when filterType is *", () => {
    const db = createTestDb()
    pushEvent(db, "w", "a")
    pushEvent(db, "w", "b")

    const events = getEventsSince(db, { filterType: "*" })
    assert.equal(events.length, 2)
    db.close()
  })

  it("tail returns last N events in order", () => {
    const db = createTestDb()
    pushEvent(db, "w", "a")
    pushEvent(db, "w", "b")
    const e3 = pushEvent(db, "w", "c")
    const e4 = pushEvent(db, "w", "d")

    const events = getEventsSince(db, { tail: 2 })
    assert.equal(events.length, 2)
    assert.equal(events[0].id, e3.id)
    assert.equal(events[1].id, e4.id)
    db.close()
  })

  it("returns empty array when no events", () => {
    const db = createTestDb()
    const events = getEventsSince(db)
    assert.deepEqual(events, [])
    db.close()
  })
})

describe("getNextEvent", () => {
  it("returns next event after sinceId", () => {
    const db = createTestDb()
    const e1 = pushEvent(db, "w", "a")
    const e2 = pushEvent(db, "w", "b")

    const next = getNextEvent(db, e1.id)
    assert.equal(next?.id, e2.id)
    db.close()
  })

  it("returns undefined when no more events", () => {
    const db = createTestDb()
    const e1 = pushEvent(db, "w", "a")

    const next = getNextEvent(db, e1.id)
    assert.equal(next, undefined)
    db.close()
  })
})

describe("pollEvents", () => {
  it("returns new events and advances cursor", () => {
    const db = createTestDb()
    pushEvent(db, "w1", "a")
    pushEvent(db, "w1", "b")

    // First poll creates cursor, which itself creates an event
    const events1 = pollEvents(db, "poller")
    // The cursor.create event is at or after the existing events
    // so the cursor is set past all events

    // Push more events after the cursor
    pushEvent(db, "w1", "c")
    pushEvent(db, "w1", "d")

    const events2 = pollEvents(db, "poller")
    assert.equal(events2.length, 2)
    assert.equal(events2[0].type, "c")
    assert.equal(events2[1].type, "d")
    db.close()
  })

  it("returns empty array when no new events", () => {
    const db = createTestDb()
    // Initialize cursor
    pollEvents(db, "poller")

    const events = pollEvents(db, "poller")
    assert.deepEqual(events, [])
    db.close()
  })
})

describe("claimEvent / getClaimant", () => {
  it("claims an event successfully", () => {
    const db = createTestDb()
    const event = pushEvent(db, "w", "task")

    const claimed = claimEvent(db, "claimer", event.id)
    assert.equal(claimed, true)
    db.close()
  })

  it("returns false when event already claimed by another worker", () => {
    const db = createTestDb()
    const event = pushEvent(db, "w", "task")

    claimEvent(db, "claimer-1", event.id)
    const claimed = claimEvent(db, "claimer-2", event.id)
    assert.equal(claimed, false)
    db.close()
  })

  it("returns true when same worker claims again", () => {
    const db = createTestDb()
    const event = pushEvent(db, "w", "task")

    claimEvent(db, "claimer", event.id)
    const claimed = claimEvent(db, "claimer", event.id)
    assert.equal(claimed, true)
    db.close()
  })

  it("getClaimant returns claimant info", () => {
    const db = createTestDb()
    const event = pushEvent(db, "w", "task")

    claimEvent(db, "claimer", event.id)
    const claimant = getClaimant(db, event.id)
    assert.equal(claimant?.worker_id, "claimer")
    assert.equal(typeof claimant?.claimed_at, "number")
    db.close()
  })

  it("getClaimant returns undefined for unclaimed event", () => {
    const db = createTestDb()
    const event = pushEvent(db, "w", "task")

    const claimant = getClaimant(db, event.id)
    assert.equal(claimant, undefined)
    db.close()
  })
})
