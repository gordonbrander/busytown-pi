// ---------------------------------------------------------------------------
// Simplified agent session events
//
// One event per logical stage — no streaming deltas, no message wrapper.
// Every event within a run carries a `correlation_id` that matches the
// originating `user_message` id.
//
// See docs/simplified-llm-events.md for the full design.
// ---------------------------------------------------------------------------

import type { AgentSessionEvent as PiAgentSessionEvent } from "@mariozechner/pi-coding-agent";

export type UserMessage = {
  type: "user_message";
  id: string;
  content: string;
};

export type AgentStart = {
  type: "agent_start";
  correlation_id: string;
};

export type AgentEnd = {
  type: "agent_end";
  correlation_id: string;
  total_input_tokens?: number;
  total_output_tokens?: number;
};

export type TurnStart = {
  type: "turn_start";
  correlation_id: string;
};

export type TurnEnd = {
  type: "turn_end";
  correlation_id: string;
  input_tokens?: number;
  output_tokens?: number;
};

export type ThinkingStart = {
  type: "thinking_start";
  correlation_id: string;
  contentIndex: number;
};

export type ThinkingEnd = {
  type: "thinking_end";
  correlation_id: string;
  contentIndex: number;
  text: string;
};

export type TextStart = {
  type: "text_start";
  correlation_id: string;
  contentIndex: number;
};

export type TextEnd = {
  type: "text_end";
  correlation_id: string;
  contentIndex: number;
  text: string;
};

export type ToolcallStart = {
  type: "toolcall_start";
  correlation_id: string;
  contentIndex: number;
  tool_call_id?: string;
  name?: string;
};

export type ToolcallEnd = {
  type: "toolcall_end";
  correlation_id: string;
  contentIndex: number;
  tool_call_id: string;
  name: string;
  args: Record<string, unknown>;
};

export type ToolExecutionEnd = {
  type: "tool_execution_end";
  correlation_id: string;
  tool_call_id: string;
  output: unknown;
  isError: boolean;
};

export type AgentError = {
  type: "error";
  correlation_id: string;
  message: string;
  code?: string;
};

export type CompactionStart = {
  type: "compaction_start";
  correlation_id: string;
  reason: "manual" | "threshold" | "overflow";
};

export type CompactionEnd = {
  type: "compaction_end";
  correlation_id: string;
  reason: "manual" | "threshold" | "overflow";
  result:
    | { summary: string; firstKeptEntryId: string; tokensBefore: number }
    | undefined;
  aborted: boolean;
  willRetry: boolean;
};

export type AutoRetryStart = {
  type: "auto_retry_start";
  correlation_id: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
};

export type AutoRetryEnd = {
  type: "auto_retry_end";
  correlation_id: string;
  success: boolean;
  finalError?: string;
};

export type AgentSessionEvent =
  | UserMessage
  | AgentStart
  | AgentEnd
  | TurnStart
  | TurnEnd
  | ThinkingStart
  | ThinkingEnd
  | TextStart
  | TextEnd
  | ToolcallStart
  | ToolcallEnd
  | ToolExecutionEnd
  | AgentError
  | CompactionStart
  | CompactionEnd
  | AutoRetryStart
  | AutoRetryEnd;

// ---------------------------------------------------------------------------
// Map Pi AgentSessionEvent → simplified AgentSessionEvent
//
// Pi's events are nested: message_update wraps AssistantMessageEvents.
// We flatten that nesting and drop streaming deltas + message envelope
// events (message_start, message_end, message_update/start, message_update/done).
//
// Returns zero or one simplified events per Pi event. Zero when the Pi event
// has no simplified equivalent (deltas, message envelope events).
// ---------------------------------------------------------------------------

/**
 * Map a Pi AgentSessionEvent to a simplified AgentSessionEvent, or undefined
 * if the Pi event has no simplified equivalent (deltas, message envelope).
 */
export const fromPiAgentSessionEvent = (
  event: PiAgentSessionEvent,
  correlationId: string,
): AgentSessionEvent | undefined => {
  switch (event.type) {
    case "agent_start":
      return { type: "agent_start", correlation_id: correlationId };

    case "agent_end":
      return { type: "agent_end", correlation_id: correlationId };

    case "turn_start":
      return { type: "turn_start", correlation_id: correlationId };

    case "turn_end":
      return { type: "turn_end", correlation_id: correlationId };

    case "message_update":
      return fromAssistantMessageEvent(
        event.assistantMessageEvent,
        correlationId,
      );

    case "tool_execution_start":
      // Simplified model has no tool_execution_start — info is on toolcall_start/end
      return undefined;

    case "tool_execution_update":
      // No streaming tool updates in simplified model
      return undefined;

    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        correlation_id: correlationId,
        tool_call_id: event.toolCallId,
        output: event.result,
        isError: event.isError,
      };

    case "compaction_start":
      return {
        type: "compaction_start",
        correlation_id: correlationId,
        reason: event.reason,
      };

    case "compaction_end":
      return {
        type: "compaction_end",
        correlation_id: correlationId,
        reason: event.reason,
        result:
          event.result !== undefined
            ? {
                summary: event.result.summary,
                firstKeptEntryId: event.result.firstKeptEntryId,
                tokensBefore: event.result.tokensBefore,
              }
            : undefined,
        aborted: event.aborted,
        willRetry: event.willRetry,
      };

    case "auto_retry_start":
      return {
        type: "auto_retry_start",
        correlation_id: correlationId,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      };

    case "auto_retry_end":
      return {
        type: "auto_retry_end",
        correlation_id: correlationId,
        success: event.success,
        finalError: event.finalError,
      };

    // message_start, message_end — envelope events, no simplified equivalent
    case "message_start":
    case "message_end":
      return undefined;
  }
};

// ---------------------------------------------------------------------------
// Map Pi AssistantMessageEvent sub-events
// ---------------------------------------------------------------------------

type PiAssistantMessageEvent = Extract<
  PiAgentSessionEvent,
  { type: "message_update" }
>["assistantMessageEvent"];

const fromAssistantMessageEvent = (
  event: PiAssistantMessageEvent,
  correlationId: string,
): AgentSessionEvent | undefined => {
  switch (event.type) {
    case "thinking_start":
      return {
        type: "thinking_start",
        correlation_id: correlationId,
        contentIndex: event.contentIndex,
      };

    case "thinking_end":
      return {
        type: "thinking_end",
        correlation_id: correlationId,
        contentIndex: event.contentIndex,
        text: event.content,
      };

    case "text_start":
      return {
        type: "text_start",
        correlation_id: correlationId,
        contentIndex: event.contentIndex,
      };

    case "text_end":
      return {
        type: "text_end",
        correlation_id: correlationId,
        contentIndex: event.contentIndex,
        text: event.content,
      };

    case "toolcall_start":
      return {
        type: "toolcall_start",
        correlation_id: correlationId,
        contentIndex: event.contentIndex,
      };

    case "toolcall_end":
      return {
        type: "toolcall_end",
        correlation_id: correlationId,
        contentIndex: event.contentIndex,
        tool_call_id: event.toolCall.id,
        name: event.toolCall.name,
        args: event.toolCall.arguments,
      };

    case "error":
      return {
        type: "error",
        correlation_id: correlationId,
        message: event.reason,
      };

    // Deltas and envelope sub-events — no simplified equivalent
    case "start":
    case "done":
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return undefined;
  }
};
