import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { virtualAgentOf } from "./virtual-agent.ts";
import type { Event } from "./lib/event.ts";
import type { SendFn } from "./agent.ts";

const testEvent = (overrides: Partial<Event> = {}): Event => ({
  id: 1,
  timestamp: Date.now(),
  type: "test.event",
  agent_id: "other-agent",
  payload: { message: "hello" },
  ...overrides,
});

const noopSend: SendFn = async () => {};

describe("virtualAgentOf", () => {
  it("returns an AgentSetup that creates an agent", async () => {
    const setup = virtualAgentOf(() => {});
    const agent = await setup("my-agent", noopSend);

    assert.equal(typeof agent.handle, "function");
    assert.equal(typeof agent[Symbol.asyncDispose], "function");
  });
});

describe("handle", () => {
  it("calls handler with send and event", async () => {
    const received: Event[] = [];
    const setup = virtualAgentOf((_send, event) => {
      received.push(event);
    });

    const agent = await setup("handler-agent", noopSend);
    const event = testEvent();
    await agent.handle(event);

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], event);
  });

  it("passes send function to handler", async () => {
    const sent: Array<{ type: string; payload: unknown }> = [];
    const fakeSend: SendFn = async (type, payload) => {
      sent.push({ type, payload });
    };

    const setup = virtualAgentOf(async (send) => {
      await send("test.response", { ok: true });
    });

    const agent = await setup("sender-agent", fakeSend);
    await agent.handle(testEvent());

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "test.response");
  });

  it("throws after dispose", async () => {
    const setup = virtualAgentOf(() => {});
    const agent = await setup("disposed-agent", noopSend);

    await agent[Symbol.asyncDispose]();
    await assert.rejects(() => agent.handle(testEvent()), /disposed/i);
  });
});

describe("dispose", () => {
  it("is idempotent", async () => {
    const setup = virtualAgentOf(() => {});
    const agent = await setup("dispose-agent", noopSend);

    await agent[Symbol.asyncDispose]();
    await agent[Symbol.asyncDispose](); // Should not throw
  });
});
