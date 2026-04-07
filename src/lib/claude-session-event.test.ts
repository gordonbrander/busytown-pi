import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fromClaudeStreamEvent,
  type ClaudeStreamEvent,
} from "./claude-session-event.ts";

const CID = "evt_42";

const claude = (obj: object): ClaudeStreamEvent => obj as ClaudeStreamEvent;

describe("fromClaudeStreamEvent", () => {
  describe("system events", () => {
    it("returns empty for system init", () => {
      const result = fromClaudeStreamEvent(
        claude({ type: "system", subtype: "init" }),
        CID,
        0,
      );
      assert.deepEqual(result.events, []);
      assert.equal(result.contentLength, 0);
    });
  });

  describe("assistant events", () => {
    it("emits agent_start + turn_start on first assistant event", () => {
      const result = fromClaudeStreamEvent(
        claude({
          type: "assistant",
          message: {
            content: [{ type: "thinking", thinking: "hmm" }],
          },
        }),
        CID,
        0,
      );

      assert.equal(result.contentLength, 1);
      assert.deepEqual(result.events[0], {
        type: "agent_start",
        correlation_id: CID,
      });
      assert.deepEqual(result.events[1], {
        type: "turn_start",
        correlation_id: CID,
      });
    });

    it("maps thinking block to thinking_start + thinking_end", () => {
      const result = fromClaudeStreamEvent(
        claude({
          type: "assistant",
          message: {
            content: [{ type: "thinking", thinking: "Let me think..." }],
          },
        }),
        CID,
        0,
      );

      assert.deepEqual(result.events[2], {
        type: "thinking_start",
        correlation_id: CID,
        contentIndex: 0,
      });
      assert.deepEqual(result.events[3], {
        type: "thinking_end",
        correlation_id: CID,
        contentIndex: 0,
        text: "Let me think...",
      });
    });

    it("maps text block (cumulative) without agent_start", () => {
      const result = fromClaudeStreamEvent(
        claude({
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "hmm" },
              { type: "text", text: "Hello world" },
            ],
          },
        }),
        CID,
        1, // already saw thinking block
      );

      // No agent_start/turn_start since prevContentLength > 0
      assert.deepEqual(result.events[0], {
        type: "text_start",
        correlation_id: CID,
        contentIndex: 1,
      });
      assert.deepEqual(result.events[1], {
        type: "text_end",
        correlation_id: CID,
        contentIndex: 1,
        text: "Hello world",
      });
      assert.equal(result.events.length, 2);
      assert.equal(result.contentLength, 2);
    });

    it("maps tool_use block to toolcall_start + toolcall_end", () => {
      const result = fromClaudeStreamEvent(
        claude({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Let me read that" },
              {
                type: "tool_use",
                id: "tool_abc",
                name: "Read",
                input: { file_path: "/tmp/test.ts" },
              },
            ],
          },
        }),
        CID,
        1, // already saw text block
      );

      assert.deepEqual(result.events[0], {
        type: "toolcall_start",
        correlation_id: CID,
        contentIndex: 1,
        tool_call_id: "tool_abc",
        name: "Read",
      });
      assert.deepEqual(result.events[1], {
        type: "toolcall_end",
        correlation_id: CID,
        contentIndex: 1,
        tool_call_id: "tool_abc",
        name: "Read",
        args: { file_path: "/tmp/test.ts" },
      });
      assert.equal(result.contentLength, 2);
    });

    it("skips unknown content block types", () => {
      const result = fromClaudeStreamEvent(
        claude({
          type: "assistant",
          message: {
            content: [{ type: "unknown_block", data: "foo" }],
          },
        }),
        CID,
        0,
      );

      // agent_start + turn_start only, no block-specific events
      assert.equal(result.events.length, 2);
      assert.equal(result.contentLength, 1);
    });
  });

  describe("result events", () => {
    it("maps success result to turn_end + agent_end", () => {
      const result = fromClaudeStreamEvent(
        claude({
          type: "result",
          subtype: "success",
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
        CID,
        2,
      );

      assert.deepEqual(result.events, [
        {
          type: "turn_end",
          correlation_id: CID,
          input_tokens: 100,
          output_tokens: 50,
        },
        {
          type: "agent_end",
          correlation_id: CID,
          total_input_tokens: 100,
          total_output_tokens: 50,
        },
      ]);
      assert.equal(result.contentLength, 2);
    });

    it("maps error result to error + turn_end + agent_end", () => {
      const result = fromClaudeStreamEvent(
        claude({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          result: "Max turns exceeded",
          usage: { input_tokens: 200, output_tokens: 100 },
        }),
        CID,
        3,
      );

      assert.equal(result.events.length, 3);
      assert.deepEqual(result.events[0], {
        type: "error",
        correlation_id: CID,
        message: "Max turns exceeded",
      });
      assert.equal(result.events[1].type, "turn_end");
      assert.equal(result.events[2].type, "agent_end");
    });

    it("uses fallback message when error result has no result field", () => {
      const result = fromClaudeStreamEvent(
        claude({
          type: "result",
          subtype: "error_unknown",
          is_error: true,
        }),
        CID,
        0,
      );

      assert.deepEqual(result.events[0], {
        type: "error",
        correlation_id: CID,
        message: "Unknown error",
      });
    });
  });

  describe("unknown event types", () => {
    it("returns empty for unrecognized event type", () => {
      const result = fromClaudeStreamEvent(
        claude({ type: "something_else" }),
        CID,
        0,
      );
      assert.deepEqual(result.events, []);
      assert.equal(result.contentLength, 0);
    });
  });
});
