// ---------------------------------------------------------------------------
// Map Claude CLI stream-json events → simplified AgentSessionEvent
//
// Claude CLI `--output-format stream-json` emits JSONL with three top-level
// event types: system, assistant, result.
//
// `assistant` events carry a cumulative `message.content` array that grows
// over time. We diff successive snapshots (via `prevContentLength`) to emit
// discrete start/end events for each new content block.
// ---------------------------------------------------------------------------

import type { AgentSessionEvent } from "./agent-session-event.ts";

// ---------------------------------------------------------------------------
// Claude CLI stream-json event shapes (subset we care about)
// ---------------------------------------------------------------------------

export type ClaudeThinkingBlock = { type: "thinking"; thinking: string };
export type ClaudeTextBlock = { type: "text"; text: string };
export type ClaudeToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ClaudeContentBlock =
  | ClaudeThinkingBlock
  | ClaudeTextBlock
  | ClaudeToolUseBlock
  | { type: string; [key: string]: unknown };

export type ClaudeStreamEvent =
  | { type: "system"; subtype: string; [key: string]: unknown }
  | {
      type: "assistant";
      message: {
        content: ClaudeContentBlock[];
        [key: string]: unknown;
      };
      [key: string]: unknown;
    }
  | {
      type: "result";
      subtype: string;
      is_error?: boolean;
      result?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };

// ---------------------------------------------------------------------------
// Mapping function
// ---------------------------------------------------------------------------

export type ClaudeSessionEventResult = {
  events: AgentSessionEvent[];
  contentLength: number;
};

/**
 * Map a single Claude CLI stream-json event to zero or more simplified
 * AgentSessionEvents. Tracks cumulative content via `prevContentLength`.
 */
export const fromClaudeStreamEvent = (
  event: ClaudeStreamEvent,
  correlationId: string,
  prevContentLength: number,
): ClaudeSessionEventResult => {
  switch (event.type) {
    case "system":
      return { events: [], contentLength: prevContentLength };

    case "assistant": {
      const content = event.message.content;
      const events: AgentSessionEvent[] = [];

      // First assistant event — emit agent_start + turn_start
      if (prevContentLength === 0) {
        events.push({ type: "agent_start", correlation_id: correlationId });
        events.push({ type: "turn_start", correlation_id: correlationId });
      }

      // Diff: emit events for each new content block
      for (let i = prevContentLength; i < content.length; i++) {
        const block = content[i];
        switch (block.type) {
          case "thinking": {
            const b = block as ClaudeThinkingBlock;
            events.push({
              type: "thinking_start",
              correlation_id: correlationId,
              contentIndex: i,
            });
            events.push({
              type: "thinking_end",
              correlation_id: correlationId,
              contentIndex: i,
              text: b.thinking,
            });
            break;
          }
          case "text": {
            const b = block as ClaudeTextBlock;
            events.push({
              type: "text_start",
              correlation_id: correlationId,
              contentIndex: i,
            });
            events.push({
              type: "text_end",
              correlation_id: correlationId,
              contentIndex: i,
              text: b.text,
            });
            break;
          }
          case "tool_use": {
            const b = block as ClaudeToolUseBlock;
            events.push({
              type: "toolcall_start",
              correlation_id: correlationId,
              contentIndex: i,
              tool_call_id: b.id,
              name: b.name,
            });
            events.push({
              type: "toolcall_end",
              correlation_id: correlationId,
              contentIndex: i,
              tool_call_id: b.id,
              name: b.name,
              args: b.input,
            });
            break;
          }
        }
      }

      return { events, contentLength: content.length };
    }

    case "result": {
      const events: AgentSessionEvent[] = [];

      if (event.is_error) {
        events.push({
          type: "error",
          correlation_id: correlationId,
          message: event.result ?? "Unknown error",
        });
      }

      events.push({
        type: "turn_end",
        correlation_id: correlationId,
        input_tokens: event.usage?.input_tokens,
        output_tokens: event.usage?.output_tokens,
      });
      events.push({
        type: "agent_end",
        correlation_id: correlationId,
        total_input_tokens: event.usage?.input_tokens,
        total_output_tokens: event.usage?.output_tokens,
      });

      return { events, contentLength: prevContentLength };
    }

    default:
      return { events: [], contentLength: prevContentLength };
  }
};
