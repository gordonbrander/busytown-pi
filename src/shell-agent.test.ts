import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shellAgentOf } from "./shell-agent.ts";
import type { Event } from "./lib/event.ts";
import type { SendFn } from "./agent.ts";

const testEvent = (overrides: Partial<Event> = {}): Event => ({
  id: 1,
  timestamp: Date.now(),
  type: "test.event",
  agent_id: "other-agent",
  payload: { message: "hello world" },
  ...overrides,
});

const collectSent = (): {
  sent: Array<{ type: string; payload: unknown }>;
  send: SendFn;
} => {
  const sent: Array<{ type: string; payload: unknown }> = [];
  const send: SendFn = async (type, payload) => {
    sent.push({ type, payload });
  };
  return { sent, send };
};

describe("shellAgentOf", () => {
  it(
    "returns an AgentSetup that creates an agent",
    { timeout: 2000 },
    async () => {
      const setup = shellAgentOf({ shellScript: "echo hi" });
      const { send } = collectSent();
      const agent = await setup("my-agent", send);

      assert.equal(typeof agent.handle, "function");
      assert.equal(typeof agent[Symbol.asyncDispose], "function");
    },
  );
});

describe("handle", () => {
  it("sends stdout lines as response events", { timeout: 2000 }, async () => {
    const setup = shellAgentOf({
      shellScript: 'echo "line one" && echo "line two"',
    });
    const { sent, send } = collectSent();
    const agent = await setup("echo-agent", send);

    await agent.handle(testEvent());

    const types = sent.map((s) => s.type);
    assert.ok(types.includes("agent.echo-agent.start"));
    assert.ok(types.includes("agent.echo-agent.end"));

    const responses = sent.filter((s) => s.type === "agent.echo-agent.output");
    assert.equal(responses.length, 2);
    assert.deepEqual(responses[0].payload, { line: "line one" });
    assert.deepEqual(responses[1].payload, { line: "line two" });
  });

  it(
    "templates event fields into the shell script",
    { timeout: 2000 },
    async () => {
      const setup = shellAgentOf({ shellScript: "echo {{type}}" });
      const { sent, send } = collectSent();
      const agent = await setup("template-agent", send);

      await agent.handle(testEvent({ type: "task.created" }));

      const responses = sent.filter(
        (s) => s.type === "agent.template-agent.output",
      );
      assert.equal(responses.length, 1);
      assert.deepEqual(responses[0].payload, { line: "task.created" });
    },
  );

  it("templates nested payload fields", { timeout: 2000 }, async () => {
    const setup = shellAgentOf({
      shellScript: "echo {{{payload.message}}}",
    });
    const { sent, send } = collectSent();
    const agent = await setup("nested-agent", send);

    await agent.handle(testEvent({ payload: { message: "hello" } }));

    const responses = sent.filter(
      (s) => s.type === "agent.nested-agent.output",
    );
    assert.equal(responses.length, 1);
    assert.deepEqual(responses[0].payload, { line: "hello" });
  });

  it(
    "sends an error event on non-zero exit code",
    { timeout: 2000 },
    async () => {
      const setup = shellAgentOf({
        shellScript: "echo before && exit 1",
      });
      const { sent, send } = collectSent();
      const agent = await setup("fail-agent", send);

      await agent.handle(testEvent());

      const errors = sent.filter((s) => s.type === "agent.fail-agent.error");
      assert.equal(errors.length, 1);
      assert.equal((errors[0].payload as { code: number }).code, 1);

      const ends = sent.filter((s) => s.type === "agent.fail-agent.end");
      assert.equal(ends.length, 0);
    },
  );

  it(
    "closes cleanly for a script with no output",
    { timeout: 2000 },
    async () => {
      const setup = shellAgentOf({ shellScript: "true" });
      const { sent, send } = collectSent();
      const agent = await setup("silent-agent", send);

      await agent.handle(testEvent());

      const types = sent.map((s) => s.type);
      assert.ok(types.includes("agent.silent-agent.start"));
      assert.ok(types.includes("agent.silent-agent.end"));

      const responses = sent.filter(
        (s) => s.type === "agent.silent-agent.response",
      );
      assert.equal(responses.length, 0);
    },
  );
});

describe("dispose", () => {
  it("throws on handle after dispose", { timeout: 2000 }, async () => {
    const setup = shellAgentOf({ shellScript: "echo hi" });
    const { send } = collectSent();
    const agent = await setup("disposed-agent", send);

    await agent[Symbol.asyncDispose]();
    await assert.rejects(() => agent.handle(testEvent()), /disposed/i);
  });

  it("is idempotent", { timeout: 2000 }, async () => {
    const setup = shellAgentOf({ shellScript: "echo hi" });
    const { send } = collectSent();
    const agent = await setup("dispose-agent", send);

    await agent[Symbol.asyncDispose]();
    await agent[Symbol.asyncDispose](); // Should not throw
  });
});
