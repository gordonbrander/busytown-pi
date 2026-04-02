import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openDb, pushEvent, getEventsSince } from "./event-queue.ts";
import { agentSystemOf } from "./agent-system.ts";
import { mockAgentOf } from "./mock-agent.ts";
import { asyncDispose } from "./lib/dispose.ts";

const createTestDb = () => openDb(":memory:");
const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));

describe("agentSystemOf", () => {
  describe("registerAgent", () => {
    it("registers agent and returns its id", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const agent = mockAgentOf({ id: "a1" });

      const id = system.registerAgent(agent);

      assert.equal(id, "a1");
      await asyncDispose(system);
      db.close();
    });

    it("throws on duplicate agent id", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const a1 = mockAgentOf({ id: "dup" });
      const a2 = mockAgentOf({ id: "dup" });

      system.registerAgent(a1);
      assert.throws(() => system.registerAgent(a2), /already registered/);

      await asyncDispose(system);
      db.close();
    });

    it("throws after system is disposed", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      await asyncDispose(system);

      const agent = mockAgentOf({ id: "late" });
      assert.throws(() => system.registerAgent(agent));

      db.close();
    });
  });

  describe("event processing", () => {
    it("agent processes matching events", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const agent = mockAgentOf({ id: "proc", listen: ["task.*"] });

      system.registerAgent(agent);
      pushEvent(db, "external", "task.created", { name: "test" });
      pushEvent(db, "external", "other.event");
      pushEvent(db, "external", "task.updated", { name: "test2" });

      await wait();
      await asyncDispose(system);

      assert.equal(agent.received.length, 2);
      assert.equal(agent.received[0].type, "task.created");
      assert.equal(agent.received[1].type, "task.updated");
      db.close();
    });

    it("agent ignores own events when ignoreSelf is true", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const agent = mockAgentOf({ id: "self-ignore", ignoreSelf: true });

      system.registerAgent(agent);
      pushEvent(db, "self-ignore", "task.created");
      pushEvent(db, "other", "task.created");

      await wait();
      await asyncDispose(system);

      assert.ok(
        agent.received.every((e) => e.agent_id !== "self-ignore"),
        "Should not process own events",
      );
      assert.equal(agent.received.length, 1);
      db.close();
    });

    it("agent processes own events when ignoreSelf is false", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const agent = mockAgentOf({ id: "self-proc", ignoreSelf: false });

      system.registerAgent(agent);
      pushEvent(db, "self-proc", "hello");

      await wait();
      await asyncDispose(system);

      assert.ok(
        agent.received.some((e) => e.agent_id === "self-proc"),
        "Should process own events",
      );
      db.close();
    });

    it("emits response drafts back into the queue", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const agent = mockAgentOf({
        id: "emitter",
        listen: ["request"],
        onEvent: () => [
          { type: "response.text", payload: { text: "hello" } },
          { type: "response.done", payload: {} },
        ],
      });

      system.registerAgent(agent);
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
    it("disposes a registered agent by id", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const agent = mockAgentOf({ id: "killable" });

      system.registerAgent(agent);
      await system.disposeAgent("killable");

      assert.ok(agent.disposed.aborted, "Agent should be disposed");

      // Events pushed after disposal should not be processed
      pushEvent(db, "other", "after-kill");
      await wait(50);

      assert.ok(
        !agent.received.some((e) => e.type === "after-kill"),
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

    it("agent unregisters itself on disposal", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const agent = mockAgentOf({ id: "unreg" });

      system.registerAgent(agent);
      await asyncDispose(agent);
      await wait(50);

      // Re-registering with same id should work since old one unregistered
      const agent2 = mockAgentOf({ id: "unreg" });
      system.registerAgent(agent2);

      await asyncDispose(system);
      db.close();
    });
  });

  describe("system disposal", () => {
    it("disposing system stops all agents", async () => {
      const db = createTestDb();
      const system = agentSystemOf(db, 10);
      const a1 = mockAgentOf({ id: "a1" });
      const a2 = mockAgentOf({ id: "a2" });

      system.registerAgent(a1);
      system.registerAgent(a2);

      await asyncDispose(system);

      assert.ok(a1.disposed.aborted, "Agent a1 should be disposed");
      assert.ok(a2.disposed.aborted, "Agent a2 should be disposed");
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
