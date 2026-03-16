import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePiLine, type PiMessage } from "./pi-stream.ts";
import { lines, filterMap } from "./stream.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cheesePath = path.join(__dirname, "..", "..", "fixtures", "cheese.jsonl");

describe("parsePiLine", () => {
  it("returns a UserMessage from message_end with role user", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
    });
    const result = parsePiLine(line);
    assert.ok(result);
    assert.equal(result.role, "user");
  });

  it("returns an AssistantMessage from message_end with role assistant", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input: 10, output: 5 },
        api: "anthropic",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        stopReason: "stop",
        timestamp: 2,
      },
    });
    const result = parsePiLine(line);
    assert.ok(result);
    assert.equal(result.role, "assistant");
  });

  it("returns a ToolResultMessage from tool_execution_end", () => {
    const line = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "abc",
      toolName: "bash",
      result: {
        role: "toolResult",
        toolCallId: "abc",
        toolName: "bash",
        content: [{ type: "text", text: "output" }],
        isError: false,
        timestamp: 3,
      },
      isError: false,
    });
    const result = parsePiLine(line);
    assert.ok(result);
    assert.equal(result.role, "toolResult");
  });

  it("returns undefined for message_start", () => {
    assert.equal(parsePiLine(JSON.stringify({ type: "message_start", message: {} })), undefined);
  });

  it("returns undefined for message_update", () => {
    assert.equal(
      parsePiLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } })),
      undefined,
    );
  });

  it("returns undefined for turn_start", () => {
    assert.equal(parsePiLine(JSON.stringify({ type: "turn_start" })), undefined);
  });

  it("returns undefined for turn_end", () => {
    assert.equal(parsePiLine(JSON.stringify({ type: "turn_end", message: {}, toolResults: [] })), undefined);
  });

  it("returns undefined for agent_start", () => {
    assert.equal(parsePiLine(JSON.stringify({ type: "agent_start" })), undefined);
  });

  it("returns undefined for agent_end", () => {
    assert.equal(parsePiLine(JSON.stringify({ type: "agent_end", messages: [] })), undefined);
  });

  it("returns undefined for tool_execution_start", () => {
    assert.equal(
      parsePiLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "x", toolName: "bash", args: {} })),
      undefined,
    );
  });

  it("returns undefined for invalid JSON", () => {
    assert.equal(parsePiLine("not json"), undefined);
  });
});

describe("cheese.jsonl integration", () => {
  it("emits user then assistant message, nothing else", async () => {
    const readable = createReadStream(cheesePath, { encoding: "utf-8" });
    const messages: PiMessage[] = [];
    for await (const msg of filterMap(lines(readable), parsePiLine)) {
      messages.push(msg);
    }

    assert.equal(messages.length, 2);

    assert.equal(messages[0].role, "user");

    assert.equal(messages[1].role, "assistant");
    const assistant = messages[1] as { role: "assistant"; usage: unknown };
    assert.ok(assistant.usage, "usage should be present and unstripped");
  });
});
