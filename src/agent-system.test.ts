import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openDb, pushEvent, getEventsSince } from "./event-queue.ts";
import { agentSystemOf } from "./agent-system.ts";
import { mockAgentOf } from "./mock-agent.ts";
import { asyncDispose } from "./lib/dispose.ts";

const createTestDb = () => openDb(":memory:");
const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));

describe("agentSystemOf", () => {
  describe("spawnAgent", () => {
    it("spawns agent and returns its id", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const mock = mockAgentOf();

      const id = await system.spawnAgent({
        id: "a1",
        listen: ["*"],
        setup: mock.setup,
      });

      assert.equal(id, "a1");
      await asyncDispose(system);
      db.close();
    });

    it("throws on duplicate agent id", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const m1 = mockAgentOf();
      const m2 = mockAgentOf();

      await system.spawnAgent({ id: "dup", listen: ["*"], setup: m1.setup });
      await assert.rejects(
        () => system.spawnAgent({ id: "dup", listen: ["*"], setup: m2.setup }),
        /already registered/,
      );

      await asyncDispose(system);
      db.close();
    });

    it("throws after system is disposed", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      await asyncDispose(system);

      const mock = mockAgentOf();
      await assert.rejects(() =>
        system.spawnAgent({ id: "late", listen: ["*"], setup: mock.setup }),
      );

      db.close();
    });
  });

  describe("event processing", () => {
    it("agent processes matching events", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const mock = mockAgentOf();

      await system.spawnAgent({
        id: "proc",
        listen: ["task.*"],
        setup: mock.setup,
      });
      pushEvent(db, "external", "task.created", { name: "test" });
      pushEvent(db, "external", "other.event");
      pushEvent(db, "external", "task.updated", { name: "test2" });

      await wait();
      await asyncDispose(system);

      assert.equal(mock.received.length, 2);
      assert.equal(mock.received[0].type, "task.created");
      assert.equal(mock.received[1].type, "task.updated");
      db.close();
    });

    it("agent ignores own events when ignoreSelf is true", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const mock = mockAgentOf();

      await system.spawnAgent({
        id: "self-ignore",
        listen: ["*"],
        ignoreSelf: true,
        setup: mock.setup,
      });
      pushEvent(db, "self-ignore", "task.created");
      pushEvent(db, "other", "task.created");

      await wait();
      await asyncDispose(system);

      assert.ok(
        mock.received.every((e) => e.agent_id !== "self-ignore"),
        "Should not process own events",
      );
      assert.equal(mock.received.length, 1);
      db.close();
    });

    it("agent processes own events when ignoreSelf is false", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const mock = mockAgentOf();

      await system.spawnAgent({
        id: "self-proc",
        listen: ["*"],
        ignoreSelf: false,
        setup: mock.setup,
      });
      pushEvent(db, "self-proc", "hello");

      await wait();
      await asyncDispose(system);

      assert.ok(
        mock.received.some((e) => e.agent_id === "self-proc"),
        "Should process own events",
      );
      db.close();
    });

    it("emits response events back into the queue via send", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const mock = mockAgentOf(async (send) => {
        await send("response.text", { text: "hello" });
        await send("response.done", {});
      });

      await system.spawnAgent({
        id: "emitter",
        listen: ["request"],
        setup: mock.setup,
      });
      pushEvent(db, "external", "request");

      await wait();
      await asyncDispose(system);

      const allEvents = getEventsSince(db);
      const responses = allEvents.filter(
        (e) => e.agent_id === "emitter" && e.type.startsWith("response."),
      );
      assert.equal(responses.length, 2);
      assert.equal(responses[0].type, "response.text");
      assert.equal(responses[1].type, "response.done");
      db.close();
    });
  });

  describe("disposeAgent", () => {
    it("disposes a spawned agent by id", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const mock = mockAgentOf();

      await system.spawnAgent({
        id: "killable",
        listen: ["*"],
        setup: mock.setup,
      });
      await system.disposeAgent("killable");

      // Events pushed after disposal should not be processed
      pushEvent(db, "other", "after-kill");
      await wait(50);

      assert.ok(
        !mock.received.some((e) => e.type === "after-kill"),
        "Should not process events after disposal",
      );

      await asyncDispose(system);
      db.close();
    });

    it("is a no-op for unknown agent id", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);

      // Should not throw
      await system.disposeAgent("nonexistent");

      await asyncDispose(system);
      db.close();
    });
  });

  describe("system disposal", () => {
    it("disposing system stops all agents", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const m1 = mockAgentOf();
      const m2 = mockAgentOf();

      await system.spawnAgent({ id: "a1", listen: ["*"], setup: m1.setup });
      await system.spawnAgent({ id: "a2", listen: ["*"], setup: m2.setup });

      await asyncDispose(system);

      // After system disposal, no events should be processed
      pushEvent(db, "other", "after-dispose");
      await wait(50);

      assert.ok(
        !m1.received.some((e) => e.type === "after-dispose"),
        "Agent a1 should not process events after system disposal",
      );
      assert.ok(
        !m2.received.some((e) => e.type === "after-dispose"),
        "Agent a2 should not process events after system disposal",
      );
      db.close();
    });

    it("disposing system is idempotent", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);

      await asyncDispose(system);
      await asyncDispose(system); // Should not throw

      db.close();
    });
  });
});
