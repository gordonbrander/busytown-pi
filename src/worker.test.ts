import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { openDb, pushEvent } from "./event-queue.ts"
import { createSystem, worker } from "./worker.ts"
import type { Event } from "./event.ts"

const createTestDb = () => openDb(":memory:")

describe("worker", () => {
  it("creates a worker with defaults", () => {
    const w = worker({
      id: "test",
      listen: ["*"],
      run: async () => {},
    })
    assert.equal(w.id, "test")
    assert.deepEqual(w.listen, ["*"])
    assert.equal(w.hidden, false)
    assert.equal(w.ignoreSelf, true)
  })

  it("respects explicit hidden and ignoreSelf", () => {
    const w = worker({
      id: "test",
      listen: ["*"],
      hidden: true,
      ignoreSelf: false,
      run: async () => {},
    })
    assert.equal(w.hidden, true)
    assert.equal(w.ignoreSelf, false)
  })
})

describe("createSystem", () => {
  it("spawn throws on duplicate worker id", () => {
    const db = createTestDb()
    const system = createSystem(db, 10)
    const w = worker({ id: "dup", listen: ["*"], run: async () => {} })
    system.spawn(w)
    assert.throws(() => system.spawn(w), /already exists/)
    system.stop()
    db.close()
  })

  it("kill returns false for unknown worker", async () => {
    const db = createTestDb()
    const system = createSystem(db, 10)
    const result = await system.kill("nonexistent")
    assert.equal(result, false)
    await system.stop()
    db.close()
  })

  it("worker processes matching events", async () => {
    const db = createTestDb()
    const system = createSystem(db, 10)
    const processed: Event[] = []

    const w = worker({
      id: "processor",
      listen: ["task.*"],
      hidden: true,
      run: async (event) => {
        processed.push(event)
      },
    })

    system.spawn(w)

    // Push events from a different worker
    pushEvent(db, "external", "task.created", { name: "test" })
    pushEvent(db, "external", "other.event")
    pushEvent(db, "external", "task.updated", { name: "test2" })

    // Give the worker time to process
    await new Promise((resolve) => setTimeout(resolve, 200))

    await system.stop()

    assert.equal(processed.length, 2)
    assert.equal(processed[0].type, "task.created")
    assert.equal(processed[1].type, "task.updated")
    db.close()
  })

  it("worker ignores own events by default", async () => {
    const db = createTestDb()
    const system = createSystem(db, 10)
    const processed: Event[] = []

    const w = worker({
      id: "self-ignorer",
      listen: ["*"],
      hidden: true,
      run: async (event) => {
        processed.push(event)
      },
    })

    system.spawn(w)

    // Push event from the worker itself
    pushEvent(db, "self-ignorer", "task.created")
    // Push event from another worker
    pushEvent(db, "other", "task.created")

    await new Promise((resolve) => setTimeout(resolve, 200))
    await system.stop()

    // Should only process the event from "other"
    assert.ok(
      processed.every((e) => e.worker_id !== "self-ignorer"),
      "Should not process own events",
    )
    db.close()
  })

  it("kill stops a running worker", async () => {
    const db = createTestDb()
    const system = createSystem(db, 10)
    const processed: Event[] = []

    const w = worker({
      id: "killable",
      listen: ["*"],
      hidden: true,
      run: async (event) => {
        processed.push(event)
      },
    })

    system.spawn(w)
    const killed = await system.kill("killable")
    assert.equal(killed, true)

    // Push event after kill — should not be processed
    pushEvent(db, "other", "task.after-kill")
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.ok(
      !processed.some((e) => e.type === "task.after-kill"),
      "Should not process events after kill",
    )

    await system.stop()
    db.close()
  })
})
