import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { virtualAgentOf } from "./virtual-agent.ts";
import type { Event } from "./lib/event.ts";
import { collect } from "./lib/generator.ts";

const testEvent = (overrides: Partial<Event> = {}): Event => ({
  id: 1,
  timestamp: Date.now(),
  type: "test.event",
  agent_id: "other-agent",
  payload: { message: "hello" },
  ...overrides,
});

describe("virtualAgentOf", () => {
  it("returns an agent with the configured properties", () => {
    const agent = virtualAgentOf({
      id: "my-agent",
      listen: ["sys.reload"],
      handler: () => {},
    });

    assert.equal(agent.id, "my-agent");
    assert.deepEqual(agent.listen, ["sys.reload"]);
    assert.equal(agent.ignoreSelf, true);
    assert.equal(agent.disposed.aborted, false);
  });

  it("defaults ignoreSelf to true", () => {
    const agent = virtualAgentOf({
      id: "agent",
      listen: [],
      handler: () => {},
    });
    assert.equal(agent.ignoreSelf, true);
  });

  it("respects ignoreSelf config", () => {
    const agent = virtualAgentOf({
      id: "agent",
      listen: [],
      ignoreSelf: false,
      handler: () => {},
    });
    assert.equal(agent.ignoreSelf, false);
  });

  it("validates id as slug", () => {
    assert.throws(
      () =>
        virtualAgentOf({
          id: "My Agent",
          listen: [],
          handler: () => {},
        }),
      /Invalid slug/,
    );
  });
});

describe("stream", () => {
  it("calls handler with the event", () => {
    const received: Event[] = [];
    const agent = virtualAgentOf({
      id: "handler-agent",
      listen: ["*"],
      handler: (event) => {
        received.push(event);
      },
    });

    const event = testEvent();
    agent.stream(event);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], event);
  });

  it("returns an empty stream", async () => {
    const agent = virtualAgentOf({
      id: "empty-agent",
      listen: ["*"],
      handler: () => {},
    });

    const drafts = await collect(agent.stream(testEvent()));
    assert.equal(drafts.length, 0);
  });

  it("throws after dispose", async () => {
    const agent = virtualAgentOf({
      id: "disposed-agent",
      listen: ["*"],
      handler: () => {},
    });

    await agent[Symbol.asyncDispose]();
    assert.throws(() => agent.stream(testEvent()));
  });
});

describe("dispose", () => {
  it("sets disposed signal to aborted", async () => {
    const agent = virtualAgentOf({
      id: "dispose-agent",
      listen: ["*"],
      handler: () => {},
    });

    assert.equal(agent.disposed.aborted, false);
    await agent[Symbol.asyncDispose]();
    assert.equal(agent.disposed.aborted, true);
  });

  it("is idempotent", async () => {
    const agent = virtualAgentOf({
      id: "dispose-agent",
      listen: ["*"],
      handler: () => {},
    });

    await agent[Symbol.asyncDispose]();
    await agent[Symbol.asyncDispose]();
    assert.equal(agent.disposed.aborted, true);
  });
});
