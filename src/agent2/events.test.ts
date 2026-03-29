import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { mapPiEvent } from "./events.ts";

/** Cast a plain object to AgentSessionEvent to keep test inputs concise. */
const pi = (obj: object): AgentSessionEvent => obj as AgentSessionEvent;

// Placeholder values for Pi fields that our mapping strips entirely.
const AGENT_MSG = { role: "assistant", content: [] };
const TOOL_RESULTS = [{ role: "toolResult" }];
const PARTIAL = { role: "assistant", content: [] };

describe("mapPiEvent", () => {
  describe("agent lifecycle", () => {
    it("maps agent_start", () => {
      assert.deepEqual(mapPiEvent(pi({ type: "agent_start" })), {
        type: "agent_start",
      });
    });

    it("strips messages from agent_end", () => {
      assert.deepEqual(
        mapPiEvent(pi({ type: "agent_end", messages: [AGENT_MSG] })),
        { type: "agent_end" },
      );
    });
  });

  describe("turn lifecycle", () => {
    it("maps turn_start", () => {
      assert.deepEqual(mapPiEvent(pi({ type: "turn_start" })), {
        type: "turn_start",
      });
    });

    it("strips message and toolResults from turn_end", () => {
      assert.deepEqual(
        mapPiEvent(
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

  describe("message lifecycle", () => {
    it("strips message from message_start", () => {
      assert.deepEqual(
        mapPiEvent(pi({ type: "message_start", message: AGENT_MSG })),
        { type: "message_start" },
      );
    });

    it("strips message from message_end", () => {
      assert.deepEqual(
        mapPiEvent(pi({ type: "message_end", message: AGENT_MSG })),
        { type: "message_end" },
      );
    });

    describe("message_update", () => {
      /** Wrap an assistantMessageEvent in a message_update Pi event. */
      const update = (assistantMessageEvent: object) =>
        pi({
          type: "message_update",
          message: AGENT_MSG,
          assistantMessageEvent,
        });

      it("strips message and partial from start", () => {
        assert.deepEqual(
          mapPiEvent(update({ type: "start", partial: PARTIAL })),
          {
            type: "message_update",
            assistantMessageEvent: { type: "start" },
          },
        );
      });

      it("strips partial from text_start", () => {
        assert.deepEqual(
          mapPiEvent(
            update({ type: "text_start", contentIndex: 0, partial: PARTIAL }),
          ),
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_start", contentIndex: 0 },
          },
        );
      });

      it("strips partial from text_delta", () => {
        assert.deepEqual(
          mapPiEvent(
            update({
              type: "text_delta",
              contentIndex: 0,
              delta: "hello",
              partial: PARTIAL,
            }),
          ),
          {
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "hello",
            },
          },
        );
      });

      it("strips partial from text_end", () => {
        assert.deepEqual(
          mapPiEvent(
            update({
              type: "text_end",
              contentIndex: 0,
              content: "hello world",
              partial: PARTIAL,
            }),
          ),
          {
            type: "message_update",
            assistantMessageEvent: {
              type: "text_end",
              contentIndex: 0,
              content: "hello world",
            },
          },
        );
      });

      it("strips partial from thinking_start", () => {
        assert.deepEqual(
          mapPiEvent(
            update({
              type: "thinking_start",
              contentIndex: 1,
              partial: PARTIAL,
            }),
          ),
          {
            type: "message_update",
            assistantMessageEvent: { type: "thinking_start", contentIndex: 1 },
          },
        );
      });

      it("strips partial from thinking_delta", () => {
        assert.deepEqual(
          mapPiEvent(
            update({
              type: "thinking_delta",
              contentIndex: 1,
              delta: "hmm",
              partial: PARTIAL,
            }),
          ),
          {
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_delta",
              contentIndex: 1,
              delta: "hmm",
            },
          },
        );
      });

      it("strips partial from thinking_end", () => {
        assert.deepEqual(
          mapPiEvent(
            update({
              type: "thinking_end",
              contentIndex: 1,
              content: "I think so",
              partial: PARTIAL,
            }),
          ),
          {
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_end",
              contentIndex: 1,
              content: "I think so",
            },
          },
        );
      });

      it("strips partial from toolcall_start", () => {
        assert.deepEqual(
          mapPiEvent(
            update({
              type: "toolcall_start",
              contentIndex: 2,
              partial: PARTIAL,
            }),
          ),
          {
            type: "message_update",
            assistantMessageEvent: { type: "toolcall_start", contentIndex: 2 },
          },
        );
      });

      it("strips partial from toolcall_delta", () => {
        assert.deepEqual(
          mapPiEvent(
            update({
              type: "toolcall_delta",
              contentIndex: 2,
              delta: '{"command"',
              partial: PARTIAL,
            }),
          ),
          {
            type: "message_update",
            assistantMessageEvent: {
              type: "toolcall_delta",
              contentIndex: 2,
              delta: '{"command"',
            },
          },
        );
      });

      it("strips partial and thoughtSignature from toolcall_end", () => {
        assert.deepEqual(
          mapPiEvent(
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
            type: "message_update",
            assistantMessageEvent: {
              type: "toolcall_end",
              contentIndex: 2,
              toolCall: {
                id: "call_1",
                name: "bash",
                arguments: { command: "ls" },
              },
            },
          },
        );
      });

      it("strips message from done", () => {
        assert.deepEqual(
          mapPiEvent(
            update({ type: "done", reason: "stop", message: AGENT_MSG }),
          ),
          {
            type: "message_update",
            assistantMessageEvent: { type: "done", reason: "stop" },
          },
        );
      });

      it("strips error message from error", () => {
        assert.deepEqual(
          mapPiEvent(
            update({ type: "error", reason: "aborted", error: AGENT_MSG }),
          ),
          {
            type: "message_update",
            assistantMessageEvent: { type: "error", reason: "aborted" },
          },
        );
      });
    });
  });

  describe("tool execution", () => {
    it("maps tool_execution_start", () => {
      assert.deepEqual(
        mapPiEvent(
          pi({
            type: "tool_execution_start",
            toolCallId: "call_1",
            toolName: "bash",
            args: { command: "ls" },
          }),
        ),
        {
          type: "tool_execution_start",
          toolCallId: "call_1",
          toolName: "bash",
          args: { command: "ls" },
        },
      );
    });

    it("strips toolName and args from tool_execution_update", () => {
      assert.deepEqual(
        mapPiEvent(
          pi({
            type: "tool_execution_update",
            toolCallId: "call_1",
            toolName: "bash",
            args: { command: "ls" },
            partialResult: { content: [{ type: "text", text: "partial..." }] },
          }),
        ),
        {
          type: "tool_execution_update",
          toolCallId: "call_1",
          partialResult: { content: [{ type: "text", text: "partial..." }] },
        },
      );
    });

    it("strips toolName from tool_execution_end", () => {
      assert.deepEqual(
        mapPiEvent(
          pi({
            type: "tool_execution_end",
            toolCallId: "call_1",
            toolName: "bash",
            result: { content: [{ type: "text", text: "output" }] },
            isError: false,
          }),
        ),
        {
          type: "tool_execution_end",
          toolCallId: "call_1",
          isError: false,
          result: { content: [{ type: "text", text: "output" }] },
        },
      );
    });
  });

  describe("compaction", () => {
    it("maps compaction_start", () => {
      assert.deepEqual(
        mapPiEvent(pi({ type: "compaction_start", reason: "threshold" })),
        { type: "compaction_start", reason: "threshold" },
      );
    });

    it("strips details from compaction_end result", () => {
      assert.deepEqual(
        mapPiEvent(
          pi({
            type: "compaction_end",
            reason: "threshold",
            result: {
              summary: "Summarized the conversation",
              firstKeptEntryId: "entry_42",
              tokensBefore: 50000,
              details: { someExtensionData: true },
            },
            aborted: false,
            willRetry: false,
          }),
        ),
        {
          type: "compaction_end",
          reason: "threshold",
          result: {
            summary: "Summarized the conversation",
            firstKeptEntryId: "entry_42",
            tokensBefore: 50000,
          },
          aborted: false,
          willRetry: false,
          errorMessage: undefined,
        },
      );
    });

    it("passes through undefined result when compaction was aborted", () => {
      assert.deepEqual(
        mapPiEvent(
          pi({
            type: "compaction_end",
            reason: "overflow",
            result: undefined,
            aborted: true,
            willRetry: false,
            errorMessage: "Compaction cancelled",
          }),
        ),
        {
          type: "compaction_end",
          reason: "overflow",
          result: undefined,
          aborted: true,
          willRetry: false,
          errorMessage: "Compaction cancelled",
        },
      );
    });
  });

  describe("auto-retry", () => {
    it("maps auto_retry_start", () => {
      assert.deepEqual(
        mapPiEvent(
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
        mapPiEvent(pi({ type: "auto_retry_end", success: true, attempt: 2 })),
        {
          type: "auto_retry_end",
          success: true,
          attempt: 2,
          finalError: undefined,
        },
      );
    });

    it("maps auto_retry_end on final failure", () => {
      assert.deepEqual(
        mapPiEvent(
          pi({
            type: "auto_retry_end",
            success: false,
            attempt: 3,
            finalError: "still overloaded after 3 attempts",
          }),
        ),
        {
          type: "auto_retry_end",
          success: false,
          attempt: 3,
          finalError: "still overloaded after 3 attempts",
        },
      );
    });
  });
});
