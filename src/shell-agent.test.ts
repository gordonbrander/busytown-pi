import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shellAgentOf } from "./shell-agent.ts";
import type { Event } from "./lib/event.ts";
import { collect } from "./lib/generator.ts";

const testEvent = (overrides: Partial<Event> = {}): Event => ({
  id: 1,
  timestamp: Date.now(),
  type: "test.event",
  agent_id: "other-agent",
  payload: { message: "hello world" },
  ...overrides,
});

describe("shellAgentOf", () => {
  it(
    "returns an agent with the configured properties",
    { timeout: 2000 },
    () => {
      const agent = shellAgentOf({
        id: "my-agent",
        listen: ["test.*"],
        shellScript: "echo hi",
      });

      assert.equal(agent.id, "my-agent");
      assert.deepEqual(agent.listen, ["test.*"]);
      assert.equal(agent.ignoreSelf, true);
      assert.equal(agent.disposed.aborted, false);
    },
  );

  it("defaults ignoreSelf to true", { timeout: 2000 }, () => {
    const agent = shellAgentOf({
      id: "agent",
      listen: [],
      shellScript: "echo hi",
    });
    assert.equal(agent.ignoreSelf, true);
  });

  it("respects ignoreSelf config", { timeout: 2000 }, () => {
    const agent = shellAgentOf({
      id: "agent",
      listen: [],
      ignoreSelf: true,
      shellScript: "echo hi",
    });
    assert.equal(agent.ignoreSelf, true);
  });
});

describe("stream", () => {
  it("streams stdout lines as response events", { timeout: 2000 }, async () => {
    const agent = shellAgentOf({
      id: "echo-agent",
      listen: ["*"],
      shellScript: 'echo "line one" && echo "line two"',
    });

    const drafts = await collect(agent.stream(testEvent()));

    assert.equal(drafts.length, 4);
    assert.equal(drafts[0].type, "agent.echo-agent.start");
    assert.deepEqual(drafts[1], {
      type: "agent.echo-agent.response",
      payload: { line: "line one" },
    });
    assert.deepEqual(drafts[2], {
      type: "agent.echo-agent.response",
      payload: { line: "line two" },
    });
    assert.equal(drafts[3].type, "agent.echo-agent.end");
  });

  it(
    "templates event fields into the shell script",
    { timeout: 2000 },
    async () => {
      const agent = shellAgentOf({
        id: "template-agent",
        listen: ["*"],
        shellScript: "echo {{type}}",
      });

      const event = testEvent({ type: "task.created" });
      const drafts = await collect(agent.stream(event));

      assert.equal(drafts.length, 3);
      assert.equal(drafts[0].type, "agent.template-agent.start");
      assert.deepEqual(drafts[1], {
        type: "agent.template-agent.response",
        payload: { line: "task.created" },
      });
      assert.equal(drafts[2].type, "agent.template-agent.end");
    },
  );

  it("templates nested payload fields", { timeout: 2000 }, async () => {
    const agent = shellAgentOf({
      id: "nested-agent",
      listen: ["*"],
      shellScript: "echo {{{payload.message}}}",
    });

    const event = testEvent({ payload: { message: "hello" } });
    const drafts = await collect(agent.stream(event));

    assert.equal(drafts.length, 3);
    assert.equal(drafts[0].type, "agent.nested-agent.start");
    assert.deepEqual(drafts[1], {
      type: "agent.nested-agent.response",
      payload: { line: "hello" },
    });
    assert.equal(drafts[2].type, "agent.nested-agent.end");
  });

  it(
    "emits an error event on non-zero exit code",
    { timeout: 2000 },
    async () => {
      const agent = shellAgentOf({
        id: "fail-agent",
        listen: ["*"],
        shellScript: "echo before && exit 1",
      });

      const drafts = await collect(agent.stream(testEvent()));

      assert.equal(drafts.length, 4);
      assert.equal(drafts[0].type, "agent.fail-agent.start");
      assert.deepEqual(drafts[1], {
        type: "agent.fail-agent.response",
        payload: { line: "before" },
      });
      assert.equal(drafts[2].type, "agent.fail-agent.error");
      assert.equal((drafts[2].payload as { code: number }).code, 1);
      assert.equal(drafts[3].type, "agent.fail-agent.end");
    },
  );

  it(
    "closes cleanly for a script with no output",
    { timeout: 2000 },
    async () => {
      const agent = shellAgentOf({
        id: "silent-agent",
        listen: ["*"],
        shellScript: "true",
      });

      const drafts = await collect(agent.stream(testEvent()));
      assert.equal(drafts.length, 2);
      assert.equal(drafts[0].type, "agent.silent-agent.start");
      assert.equal(drafts[1].type, "agent.silent-agent.end");
    },
  );

  it("supports cancellation via stream cancel", { timeout: 2000 }, async () => {
    const agent = shellAgentOf({
      id: "cancel-agent",
      listen: ["*"],
      shellScript: "echo start && sleep 60",
    });

    const stream = agent.stream(testEvent());
    const reader = stream.getReader();

    // First event is the start lifecycle event
    const { value: startEvent } = await reader.read();
    assert.equal(startEvent!.type, "agent.cancel-agent.start");

    const { value } = await reader.read();
    assert.deepEqual(value, {
      type: "agent.cancel-agent.response",
      payload: { line: "start" },
    });

    // Cancel the stream, which should kill the process
    await reader.cancel();
  });
});

describe("dispose", () => {
  it("sets disposed signal to aborted", { timeout: 2000 }, async () => {
    const agent = shellAgentOf({
      id: "dispose-agent",
      listen: ["*"],
      shellScript: "echo hi",
    });

    assert.equal(agent.disposed.aborted, false);
    await agent[Symbol.asyncDispose]();
    assert.equal(agent.disposed.aborted, true);
  });

  it("is idempotent", { timeout: 2000 }, async () => {
    const agent = shellAgentOf({
      id: "dispose-agent",
      listen: ["*"],
      shellScript: "echo hi",
    });

    await agent[Symbol.asyncDispose]();
    await agent[Symbol.asyncDispose]();
    assert.equal(agent.disposed.aborted, true);
  });

  it("throws on stream after dispose", { timeout: 2000 }, async () => {
    const agent = shellAgentOf({
      id: "disposed-agent",
      listen: ["*"],
      shellScript: "echo hi",
    });

    await agent[Symbol.asyncDispose]();
    assert.throws(() => agent.stream(testEvent()));
  });
});
