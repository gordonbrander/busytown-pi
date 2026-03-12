import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openDb, pushEvent } from "./event-queue.ts";
import { createAgentSystem, agent } from "./agent-system.ts";
import type { Event } from "./lib/event.ts";

const createTestDb = () => openDb(":memory:");

describe("agent", () => {
  it("creates an agent with defaults", () => {
    const a = agent({
      id: "test",
      listen: ["*"],
      run: async () => {},
    });
    assert.equal(a.id, "test");
    assert.deepEqual(a.listen, ["*"]);
    assert.equal(a.hidden, false);
    assert.equal(a.ignoreSelf, true);
  });

  it("respects explicit hidden and ignoreSelf", () => {
    const a = agent({
      id: "test",
      listen: ["*"],
      hidden: true,
      ignoreSelf: false,
      run: async () => {},
    });
    assert.equal(a.hidden, true);
    assert.equal(a.ignoreSelf, false);
  });
});

describe("createAgentSystem", () => {
  it("spawn throws on duplicate agent id", () => {
    const db = createTestDb();
    const system = createAgentSystem(db, 10);
    const a = agent({ id: "dup", listen: ["*"], run: async () => {} });
    system.spawn(a);
    assert.throws(() => system.spawn(a), /already exists/);
    system.stop();
    db.close();
  });

  it("kill returns false for unknown agent", async () => {
    const db = createTestDb();
    const system = createAgentSystem(db, 10);
    const result = await system.kill("nonexistent");
    assert.equal(result, false);
    await system.stop();
    db.close();
  });

  it("agent processes matching events", async () => {
    const db = createTestDb();
    const system = createAgentSystem(db, 10);
    const processed: Event[] = [];

    const a = agent({
      id: "processor",
      listen: ["task.*"],
      hidden: true,
      run: async (event) => {
        processed.push(event);
      },
    });

    system.spawn(a);

    // Push events from a different agent
    pushEvent(db, "external", "task.created", { name: "test" });
    pushEvent(db, "external", "other.event");
    pushEvent(db, "external", "task.updated", { name: "test2" });

    // Give the agent time to process
    await new Promise((resolve) => setTimeout(resolve, 200));

    await system.stop();

    assert.equal(processed.length, 2);
    assert.equal(processed[0].type, "task.created");
    assert.equal(processed[1].type, "task.updated");
    db.close();
  });

  it("agent ignores own events by default", async () => {
    const db = createTestDb();
    const system = createAgentSystem(db, 10);
    const processed: Event[] = [];

    const a = agent({
      id: "self-ignorer",
      listen: ["*"],
      hidden: true,
      run: async (event) => {
        processed.push(event);
      },
    });

    system.spawn(a);

    // Push event from the agent itself
    pushEvent(db, "self-ignorer", "task.created");
    // Push event from another agent
    pushEvent(db, "other", "task.created");

    await new Promise((resolve) => setTimeout(resolve, 200));
    await system.stop();

    // Should only process the event from "other"
    assert.ok(
      processed.every((e) => e.agent_id !== "self-ignorer"),
      "Should not process own events",
    );
    db.close();
  });

  it("kill stops a running agent", async () => {
    const db = createTestDb();
    const system = createAgentSystem(db, 10);
    const processed: Event[] = [];

    const a = agent({
      id: "killable",
      listen: ["*"],
      hidden: true,
      run: async (event) => {
        processed.push(event);
      },
    });

    system.spawn(a);
    const killed = await system.kill("killable");
    assert.equal(killed, true);

    // Push event after kill — should not be processed
    pushEvent(db, "other", "task.after-kill");
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.ok(
      !processed.some((e) => e.type === "task.after-kill"),
      "Should not process events after kill",
    );

    await system.stop();
    db.close();
  });
});
