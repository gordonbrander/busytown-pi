import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunEvent } from "./types.ts";
import { mockAgent } from "./mock-agent.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read events from the output stream until (and including) `agent_end`.
 * Releases the reader lock before returning so callers can read subsequent runs.
 */
const collectRun = async (
  output: ReadableStream<AgentRunEvent>,
): Promise<AgentRunEvent[]> => {
  const events: AgentRunEvent[] = [];
  const reader = output.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      events.push(value);
      if (value.type === "agent_end") break;
    }
  } finally {
    reader.releaseLock();
  }
  return events;
};

const eventTypes = (events: AgentRunEvent[]): string[] =>
  events.map((e) => e.type);

// ---------------------------------------------------------------------------
// AgentProcess contract — verified via mockAgent
// ---------------------------------------------------------------------------

describe("mockAgent", () => {
  // --- Identity ---

  it("exposes the configured id", async () => {
    const proc = mockAgent("my-agent");
    assert.equal(proc.id, "my-agent");
    await proc.dispose();
  });

  // --- Output stream ---

  it("output is a ReadableStream", async () => {
    const proc = mockAgent("test");
    assert.ok(proc.output instanceof ReadableStream);
    await proc.dispose();
  });

  // --- Event sequence ---

  it("emits agent_start, turn_start, text_end, turn_end, agent_end in order", async () => {
    const proc = mockAgent("test");
    const [events] = await Promise.all([
      collectRun(proc.output),
      proc.send("msg"),
    ]);
    assert.deepEqual(eventTypes(events), [
      "agent_start",
      "turn_start",
      "text_end",
      "turn_end",
      "agent_end",
    ]);
    await proc.dispose();
  });

  it("text_end carries a string content field", async () => {
    const proc = mockAgent("test");
    const [events] = await Promise.all([
      collectRun(proc.output),
      proc.send("msg"),
    ]);
    const textEnd = events.find((e) => e.type === "text_end");
    assert.ok(textEnd?.type === "text_end");
    assert.equal(typeof textEnd.content, "string");
    await proc.dispose();
  });

  // --- Backpressure ---

  it("send() resolves after agent_end is emitted on the output stream", async () => {
    const proc = mockAgent("test");
    let agentEndSeen = false;
    const reader = proc.output.getReader();

    const collectionDone = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        if (value.type === "agent_end") {
          agentEndSeen = true;
          break;
        }
      }
      reader.releaseLock();
    })();

    await proc.send("msg");
    await collectionDone;
    assert.equal(agentEndSeen, true);

    await proc.dispose();
  });

  // --- Sequential sends ---

  it("sequential sends each produce a complete event sequence", async () => {
    const proc = mockAgent("test");

    const [run1] = await Promise.all([
      collectRun(proc.output),
      proc.send("first"),
    ]);

    const [run2] = await Promise.all([
      collectRun(proc.output),
      proc.send("second"),
    ]);

    assert.deepEqual(eventTypes(run1), [
      "agent_start",
      "turn_start",
      "text_end",
      "turn_end",
      "agent_end",
    ]);
    assert.deepEqual(eventTypes(run2), [
      "agent_start",
      "turn_start",
      "text_end",
      "turn_end",
      "agent_end",
    ]);

    await proc.dispose();
  });

  // --- Abort ---

  it("abort causes send() to resolve normally (no rejection)", async () => {
    const proc = mockAgent("test");
    const ac = new AbortController();
    ac.abort();

    // Must not throw
    await Promise.all([collectRun(proc.output), proc.send("msg", ac.signal)]);

    await proc.dispose();
  });

  it("abort still results in agent_end being emitted", async () => {
    const proc = mockAgent("test");
    const ac = new AbortController();
    ac.abort();

    const [events] = await Promise.all([
      collectRun(proc.output),
      proc.send("msg", ac.signal),
    ]);

    assert.ok(events.some((e) => e.type === "agent_end"));

    await proc.dispose();
  });

  it("abort does not tear down the process — the next send() succeeds", async () => {
    const proc = mockAgent("test");
    const ac = new AbortController();
    ac.abort();

    await Promise.all([collectRun(proc.output), proc.send("first", ac.signal)]);

    const [events] = await Promise.all([
      collectRun(proc.output),
      proc.send("second"),
    ]);

    assert.deepEqual(eventTypes(events), [
      "agent_start",
      "turn_start",
      "text_end",
      "turn_end",
      "agent_end",
    ]);

    await proc.dispose();
  });

  // --- Dispose ---

  it("dispose() closes the output stream", async () => {
    const proc = mockAgent("test");
    const reader = proc.output.getReader();

    await proc.dispose();

    const { done } = await reader.read();
    assert.equal(done, true);

    reader.releaseLock();
  });

  it("send() after dispose() rejects", async () => {
    const proc = mockAgent("test");
    await proc.dispose();
    await assert.rejects(() => proc.send("hello"));
  });
});
