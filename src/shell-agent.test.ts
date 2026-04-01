import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shellAgentOf } from "./shell-agent.ts";
import type { Event } from "./lib/event.ts";
import type { EventDraft } from "./lib/event.ts";
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
  it("returns an agent with the configured properties", () => {
    const agent = shellAgentOf({
      id: "my-agent",
      listen: ["test.*"],
      shellScript: "echo hi",
    });

    assert.equal(agent.id, "my-agent");
    assert.deepEqual(agent.listen, ["test.*"]);
    assert.equal(agent.ignoreSelf, false);
    assert.equal(agent.disposed.aborted, false);
  });

  it("defaults ignoreSelf to false", () => {
    const agent = shellAgentOf({
      id: "agent",
      listen: [],
      shellScript: "echo hi",
    });
    assert.equal(agent.ignoreSelf, false);
  });

  it("respects ignoreSelf config", () => {
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
  it("streams stdout lines as response events", async () => {
    const agent = shellAgentOf({
      id: "echo-agent",
      listen: ["*"],
      shellScript: 'echo "line one" && echo "line two"',
    });

    const drafts = await collect(agent.stream(testEvent()));

    assert.equal(drafts.length, 2);
    assert.deepEqual(drafts[0], {
      type: "agent.echo-agent.response",
      payload: { line: "line one" },
    });
    assert.deepEqual(drafts[1], {
      type: "agent.echo-agent.response",
      payload: { line: "line two" },
    });
  });

  it("templates event fields into the shell script", async () => {
    const agent = shellAgentOf({
      id: "template-agent",
      listen: ["*"],
      shellScript: "echo {{type}}",
    });

    const event = testEvent({ type: "task.created" });
    const drafts = await collect(agent.stream(event));

    assert.equal(drafts.length, 1);
    assert.deepEqual(drafts[0], {
      type: "agent.template-agent.response",
      payload: { line: "task.created" },
    });
  });

  it("templates nested payload fields", async () => {
    const agent = shellAgentOf({
      id: "nested-agent",
      listen: ["*"],
      shellScript: "echo {{{payload.message}}}",
    });

    const event = testEvent({ payload: { message: "hello" } });
    const drafts = await collect(agent.stream(event));

    assert.equal(drafts.length, 1);
    assert.deepEqual(drafts[0], {
      type: "agent.nested-agent.response",
      payload: { line: "hello" },
    });
  });

  it("emits an error event on non-zero exit code", async () => {
    const agent = shellAgentOf({
      id: "fail-agent",
      listen: ["*"],
      shellScript: "echo before && exit 1",
    });

    const drafts = await collect(agent.stream(testEvent()));

    assert.equal(drafts.length, 2);
    assert.deepEqual(drafts[0], {
      type: "agent.fail-agent.response",
      payload: { line: "before" },
    });
    assert.equal(drafts[1].type, "agent.fail-agent.error");
    assert.equal((drafts[1].payload as { code: number }).code, 1);
  });

  it("closes cleanly for a script with no output", async () => {
    const agent = shellAgentOf({
      id: "silent-agent",
      listen: ["*"],
      shellScript: "true",
    });

    const drafts = await collect(agent.stream(testEvent()));
    assert.equal(drafts.length, 0);
  });

  it("supports cancellation via stream cancel", async () => {
    const agent = shellAgentOf({
      id: "cancel-agent",
      listen: ["*"],
      shellScript: "echo start && sleep 60",
    });

    const stream = agent.stream(testEvent());
    const reader = stream.getReader();

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
  it("sets disposed signal to aborted", async () => {
    const agent = shellAgentOf({
      id: "dispose-agent",
      listen: ["*"],
      shellScript: "echo hi",
    });

    assert.equal(agent.disposed.aborted, false);
    await agent[Symbol.asyncDispose]();
    assert.equal(agent.disposed.aborted, true);
  });

  it("is idempotent", async () => {
    const agent = shellAgentOf({
      id: "dispose-agent",
      listen: ["*"],
      shellScript: "echo hi",
    });

    await agent[Symbol.asyncDispose]();
    await agent[Symbol.asyncDispose]();
    assert.equal(agent.disposed.aborted, true);
  });

  it("throws on stream after dispose", async () => {
    const agent = shellAgentOf({
      id: "disposed-agent",
      listen: ["*"],
      shellScript: "echo hi",
    });

    await agent[Symbol.asyncDispose]();
    assert.throws(() => agent.stream(testEvent()));
  });
});
