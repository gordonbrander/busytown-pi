import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent as PiAgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { fromPiAgentSessionEvent } from "./agent-session-event.ts";

/** Cast a plain object to PiAgentSessionEvent to keep test inputs concise. */
const pi = (obj: object): PiAgentSessionEvent => obj as PiAgentSessionEvent;

// Placeholder values for Pi fields that our mapping strips.
const AGENT_MSG = { role: "assistant", content: [], stopReason: "stop" };
const TOOL_RESULTS = [{ role: "toolResult" }];
const PARTIAL = { role: "assistant", content: [] };

/** Clone AGENT_MSG with overrides — used for message_end error tests. */
const assistantMsg = (overrides: object) => ({ ...AGENT_MSG, ...overrides });

/** Wrap an assistantMessageEvent in a message_update Pi event. */
const update = (assistantMessageEvent: object) =>
  pi({
    type: "message_update",
    message: AGENT_MSG,
    assistantMessageEvent,
  });

describe("fromPiAgentSessionEvent", () => {
  describe("agent lifecycle", () => {
    it("maps agent_start", () => {
      assert.deepEqual(fromPiAgentSessionEvent(pi({ type: "agent_start" })), {
        type: "agent_start",
      });
    });

    it("maps agent_end, strips messages", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          pi({ type: "agent_end", messages: [AGENT_MSG] }),
        ),
        { type: "agent_end" },
      );
    });
  });

  describe("turn lifecycle", () => {
    it("maps turn_start", () => {
      assert.deepEqual(fromPiAgentSessionEvent(pi({ type: "turn_start" })), {
        type: "turn_start",
      });
    });

    it("maps turn_end, strips message and toolResults", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          pi({
            type: "turn_end",
            message: AGENT_MSG,
            toolResults: TOOL_RESULTS,
          }),
        ),
        { type: "turn_end" },
      );
    });
  });

  describe("message envelope events", () => {
    it("returns undefined for message_start", () => {
      assert.equal(
        fromPiAgentSessionEvent(
          pi({ type: "message_start", message: AGENT_MSG }),
        ),
        undefined,
      );
    });

    it("returns undefined for successful message_end", () => {
      assert.equal(
        fromPiAgentSessionEvent(
          pi({ type: "message_end", message: AGENT_MSG }),
        ),
        undefined,
      );
    });
  });

  describe("message_end with failed/aborted assistant message", () => {
    it("maps stopReason: error with errorMessage to simplified error event", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          pi({
            type: "message_end",
            message: assistantMsg({
              stopReason: "error",
              errorMessage: '400 {"type":"error", … plan limits …}',
            }),
          }),
        ),
        {
          type: "error",
          message: '400 {"type":"error", … plan limits …}',
          code: "error",
        },
      );
    });

    it("maps stopReason: aborted without errorMessage, falling back to stopReason", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          pi({
            type: "message_end",
            message: assistantMsg({ stopReason: "aborted" }),
          }),
        ),
        {
          type: "error",
          message: "aborted",
          code: "aborted",
        },
      );
    });

    it("returns undefined for assistant message with stopReason: stop", () => {
      assert.equal(
        fromPiAgentSessionEvent(
          pi({
            type: "message_end",
            message: assistantMsg({ stopReason: "stop" }),
          }),
        ),
        undefined,
      );
    });

    it("returns undefined for user messages (no stopReason)", () => {
      assert.equal(
        fromPiAgentSessionEvent(
          pi({
            type: "message_end",
            message: { role: "user", content: "hello" },
          }),
        ),
        undefined,
      );
    });

    it("returns undefined for toolResult messages", () => {
      assert.equal(
        fromPiAgentSessionEvent(
          pi({
            type: "message_end",
            message: {
              role: "toolResult",
              toolCallId: "call_1",
              content: "ok",
              isError: false,
            },
          }),
        ),
        undefined,
      );
    });
  });

  describe("thinking events (flattened from message_update)", () => {
    it("maps thinking_start", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          update({ type: "thinking_start", contentIndex: 0, partial: PARTIAL }),
        ),
        { type: "thinking_start", contentIndex: 0 },
      );
    });

    it("maps thinking_end with text", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          update({
            type: "thinking_end",
            contentIndex: 0,
            content: "I should search first",
            partial: PARTIAL,
          }),
        ),
        {
          type: "thinking_end",
          contentIndex: 0,
          content: "I should search first",
        },
      );
    });
  });

  describe("text events (flattened from message_update)", () => {
    it("maps text_start", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          update({ type: "text_start", contentIndex: 1, partial: PARTIAL }),
        ),
        { type: "text_start", contentIndex: 1 },
      );
    });

    it("maps text_end with text", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          update({
            type: "text_end",
            contentIndex: 1,
            content: "Hello world",
            partial: PARTIAL,
          }),
        ),
        {
          type: "text_end",
          contentIndex: 1,
          content: "Hello world",
        },
      );
    });
  });

  describe("tool call events (flattened from message_update)", () => {
    it("maps toolcall_start without id or name", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          update({ type: "toolcall_start", contentIndex: 2, partial: PARTIAL }),
        ),
        { type: "toolcall_start", contentIndex: 2 },
      );
    });

    it("maps toolcall_end with id, name, and args", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          update({
            type: "toolcall_end",
            contentIndex: 2,
            partial: PARTIAL,
            toolCall: {
              type: "toolCall",
              id: "call_1",
              name: "bash",
              arguments: { command: "ls" },
              thoughtSignature: "sig_abc",
            },
          }),
        ),
        {
          type: "toolcall_end",
          contentIndex: 2,
          tool_call_id: "call_1",
          name: "bash",
          args: { command: "ls" },
        },
      );
    });
  });

  describe("delta events are dropped", () => {
    it("returns undefined for text_delta", () => {
      assert.equal(
        fromPiAgentSessionEvent(
          update({
            type: "text_delta",
            contentIndex: 0,
            delta: "hel",
            partial: PARTIAL,
          }),
        ),
        undefined,
      );
    });

    it("returns undefined for thinking_delta", () => {
      assert.equal(
        fromPiAgentSessionEvent(
          update({
            type: "thinking_delta",
            contentIndex: 0,
            delta: "hmm",
            partial: PARTIAL,
          }),
        ),
        undefined,
      );
    });

    it("returns undefined for toolcall_delta", () => {
      assert.equal(
        fromPiAgentSessionEvent(
          update({
            type: "toolcall_delta",
            contentIndex: 2,
            delta: '{"cmd"',
            partial: PARTIAL,
          }),
        ),
        undefined,
      );
    });
  });

  describe("message_update envelope sub-events are dropped", () => {
    it("returns undefined for start", () => {
      assert.equal(
        fromPiAgentSessionEvent(update({ type: "start", partial: PARTIAL })),
        undefined,
      );
    });

    it("returns undefined for done", () => {
      assert.equal(
        fromPiAgentSessionEvent(
          update({ type: "done", reason: "stop", message: AGENT_MSG }),
        ),
        undefined,
      );
    });
  });

  describe("error (flattened from message_update)", () => {
    it("maps error with reason as both message and code", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          update({ type: "error", reason: "aborted", error: AGENT_MSG }),
        ),
        {
          type: "error",
          message: "aborted",
          code: "aborted",
        },
      );
    });
  });

  describe("tool execution", () => {
    it("returns undefined for tool_execution_start", () => {
      assert.equal(
        fromPiAgentSessionEvent(
          pi({
            type: "tool_execution_start",
            toolCallId: "call_1",
            toolName: "bash",
            args: { command: "ls" },
          }),
        ),
        undefined,
      );
    });

    it("returns undefined for tool_execution_update", () => {
      assert.equal(
        fromPiAgentSessionEvent(
          pi({
            type: "tool_execution_update",
            toolCallId: "call_1",
            toolName: "bash",
            args: { command: "ls" },
            partialResult: "partial...",
          }),
        ),
        undefined,
      );
    });

    it("maps tool_execution_end", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          pi({
            type: "tool_execution_end",
            toolCallId: "call_1",
            toolName: "bash",
            result: "file1.ts\nfile2.ts",
            isError: false,
          }),
        ),
        {
          type: "tool_execution_end",
          tool_call_id: "call_1",
          output: "file1.ts\nfile2.ts",
          isError: false,
        },
      );
    });

    it("maps tool_execution_end with error", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          pi({
            type: "tool_execution_end",
            toolCallId: "call_2",
            toolName: "bash",
            result: "command not found",
            isError: true,
          }),
        ),
        {
          type: "tool_execution_end",
          tool_call_id: "call_2",
          output: "command not found",
          isError: true,
        },
      );
    });
  });

  describe("compaction", () => {
    it("maps compaction_start", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          pi({ type: "compaction_start", reason: "threshold" }),
        ),
        { type: "compaction_start", reason: "threshold" },
      );
    });

    it("maps compaction_end with result, strips details", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          pi({
            type: "compaction_end",
            reason: "threshold",
            result: {
              summary: "Summarized",
              firstKeptEntryId: "entry_42",
              tokensBefore: 50000,
              details: { extensionData: true },
            },
            aborted: false,
            willRetry: false,
          }),
        ),
        {
          type: "compaction_end",
          reason: "threshold",
          result: {
            summary: "Summarized",
            firstKeptEntryId: "entry_42",
            tokensBefore: 50000,
          },
          aborted: false,
          willRetry: false,
        },
      );
    });

    it("maps compaction_end with undefined result when aborted", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          pi({
            type: "compaction_end",
            reason: "overflow",
            result: undefined,
            aborted: true,
            willRetry: true,
          }),
        ),
        {
          type: "compaction_end",
          reason: "overflow",
          result: undefined,
          aborted: true,
          willRetry: true,
        },
      );
    });
  });

  describe("auto-retry", () => {
    it("maps auto_retry_start", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          pi({
            type: "auto_retry_start",
            attempt: 1,
            maxAttempts: 3,
            delayMs: 2000,
            errorMessage: "529 overloaded",
          }),
        ),
        {
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 2000,
          errorMessage: "529 overloaded",
        },
      );
    });

    it("maps auto_retry_end on success", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          pi({ type: "auto_retry_end", success: true, attempt: 2 }),
        ),
        {
          type: "auto_retry_end",
          success: true,
          finalError: undefined,
        },
      );
    });

    it("maps auto_retry_end on failure", () => {
      assert.deepEqual(
        fromPiAgentSessionEvent(
          pi({
            type: "auto_retry_end",
            success: false,
            attempt: 3,
            finalError: "still overloaded",
          }),
        ),
        {
          type: "auto_retry_end",
          success: false,
          finalError: "still overloaded",
        },
      );
    });
  });
});
