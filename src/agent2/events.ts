import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { type Event } from "../lib/event.ts";

export type PiAgentSessionEvent = AgentSessionEvent;

// Derive Pi's AssistantMessageEvent and CompactionResult from AgentSessionEvent
// rather than importing from transitive dependencies directly.
type PiAssistantMessageEvent = Extract<
  AgentSessionEvent,
  { type: "message_update" }
>["assistantMessageEvent"];

type PiCompactionResult = NonNullable<
  Extract<AgentSessionEvent, { type: "compaction_end" }>["result"]
>;

export type RequestEvent = Event;

// ---------------------------------------------------------------------------
// AssistantMessageEvent (trimmed)
//
// Pi carries `partial: AssistantMessage` on every sub-type — that is the
// accumulated partial message, reconstructible from previous events, so it
// is trimmed here. `thoughtSignature` on `toolcall_end` is a provider
// implementation detail and is also trimmed.
// ---------------------------------------------------------------------------

export type ToolCallInfo = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type AssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallInfo }
  | { type: "done"; reason: "stop" | "length" | "toolUse" }
  | { type: "error"; reason: "aborted" | "error" };

// ---------------------------------------------------------------------------
// CompactionResult (trimmed)
//
// Pi's CompactionResult also carries `details?: T` for extension-specific
// opaque data, which is trimmed here.
// ---------------------------------------------------------------------------

export type CompactionResult = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
};

// ---------------------------------------------------------------------------
// Agent response events
//
// Directly mirrors Pi's AgentEvent + AgentSessionEvent unions, with
// redundant / reconstructible payload fields trimmed per event.
// ---------------------------------------------------------------------------

// Agent lifecycle
// Pi: agent_start has no payload; agent_end carries messages[] — trimmed.
export type AgentStartEvent = { type: "agent_start" };
export type AgentEndEvent = { type: "agent_end" };

// Turn lifecycle
// Pi: turn_start has no payload; turn_end carries message + toolResults — trimmed.
export type TurnStartEvent = { type: "turn_start" };
export type TurnEndEvent = { type: "turn_end" };

// Message lifecycle
// Pi: message_start / message_end carry message: AgentMessage — trimmed
// (accumulated state, reconstructible from the event stream).
// Pi: message_update carries message: AgentMessage (trimmed) + assistantMessageEvent (kept, partial trimmed).
export type MessageStartEvent = { type: "message_start" };
export type MessageUpdateEvent = {
  type: "message_update";
  assistantMessageEvent: AssistantMessageEvent;
};
export type MessageEndEvent = { type: "message_end" };

// Tool execution
// Pi: tool_execution_update also carries toolName + args — trimmed
// (already known from the preceding tool_execution_start, correlate via toolCallId).
// Pi: tool_execution_end also carries toolName — trimmed for the same reason.
export type ToolExecutionStartEvent = {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
};
export type ToolExecutionUpdateEvent = {
  type: "tool_execution_update";
  toolCallId: string;
  partialResult: unknown;
};
export type ToolExecutionEndEvent = {
  type: "tool_execution_end";
  toolCallId: string;
  isError: boolean;
  result: unknown;
};

// Compaction
// reason "manual" covers the compact() RPC command; "threshold" / "overflow"
// are automatic triggers.
export type CompactionStartEvent = {
  type: "compaction_start";
  reason: "manual" | "threshold" | "overflow";
};
export type CompactionEndEvent = {
  type: "compaction_end";
  reason: "manual" | "threshold" | "overflow";
  result: CompactionResult | undefined;
  aborted: boolean;
  willRetry: boolean;
  errorMessage?: string;
};

// Auto-retry (triggered on transient errors: overloaded, rate limit, 5xx)
export type AutoRetryStartEvent = {
  type: "auto_retry_start";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
};
export type AutoRetryEndEvent = {
  type: "auto_retry_end";
  success: boolean;
  attempt: number;
  finalError?: string;
};

export type ResponseEvent =
  | AgentStartEvent
  | TurnStartEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | TurnEndEvent
  | AgentEndEvent
  | CompactionStartEvent
  | CompactionEndEvent
  | AutoRetryStartEvent
  | AutoRetryEndEvent;

/**
 * The four event shapes that carry a fully-assembled, actionable result,
 * as described in the minimal consumer guide:
 *
 *   • message_update / text_end      — full assembled text
 *   • message_update / thinking_end  — full assembled thinking
 *   • message_update / toolcall_end  — full tool call (id, name, arguments)
 *   • tool_execution_end             — full tool result
 */
export type FinishedResponseEvent =
  | {
      type: "message_update";
      assistantMessageEvent: Extract<
        AssistantMessageEvent,
        { type: "text_end" | "thinking_end" | "toolcall_end" }
      >;
    }
  | ToolExecutionEndEvent;

const mapAssistantMessageEvent = (
  e: PiAssistantMessageEvent,
): AssistantMessageEvent => {
  switch (e.type) {
    case "start":
      return { type: "start" };
    case "text_start":
      return { type: "text_start", contentIndex: e.contentIndex };
    case "text_delta":
      return {
        type: "text_delta",
        contentIndex: e.contentIndex,
        delta: e.delta,
      };
    case "text_end":
      return {
        type: "text_end",
        contentIndex: e.contentIndex,
        content: e.content,
      };
    case "thinking_start":
      return { type: "thinking_start", contentIndex: e.contentIndex };
    case "thinking_delta":
      return {
        type: "thinking_delta",
        contentIndex: e.contentIndex,
        delta: e.delta,
      };
    case "thinking_end":
      return {
        type: "thinking_end",
        contentIndex: e.contentIndex,
        content: e.content,
      };
    case "toolcall_start":
      return { type: "toolcall_start", contentIndex: e.contentIndex };
    case "toolcall_delta":
      return {
        type: "toolcall_delta",
        contentIndex: e.contentIndex,
        delta: e.delta,
      };
    case "toolcall_end":
      return {
        type: "toolcall_end",
        contentIndex: e.contentIndex,
        toolCall: {
          id: e.toolCall.id,
          name: e.toolCall.name,
          arguments: e.toolCall.arguments,
        },
      };
    case "done":
      return { type: "done", reason: e.reason };
    case "error":
      return { type: "error", reason: e.reason };
  }
};

const mapCompactionResult = (result: PiCompactionResult): CompactionResult => ({
  summary: result.summary,
  firstKeptEntryId: result.firstKeptEntryId,
  tokensBefore: result.tokensBefore,
});

export const mapPiEvent = (event: AgentSessionEvent): ResponseEvent => {
  switch (event.type) {
    case "agent_start":
      return { type: "agent_start" };
    case "agent_end":
      return { type: "agent_end" };
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return { type: "turn_end" };
    case "message_start":
      return { type: "message_start" };
    case "message_update":
      return {
        type: "message_update",
        assistantMessageEvent: mapAssistantMessageEvent(
          event.assistantMessageEvent,
        ),
      };
    case "message_end":
      return { type: "message_end" };
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        toolCallId: event.toolCallId,
        partialResult: event.partialResult,
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        isError: event.isError,
        result: event.result,
      };
    case "compaction_start":
      return { type: "compaction_start", reason: event.reason };
    case "compaction_end":
      return {
        type: "compaction_end",
        reason: event.reason,
        result:
          event.result !== undefined
            ? mapCompactionResult(event.result)
            : undefined,
        aborted: event.aborted,
        willRetry: event.willRetry,
        errorMessage: event.errorMessage,
      };
    case "auto_retry_start":
      return {
        type: "auto_retry_start",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      };
    case "auto_retry_end":
      return {
        type: "auto_retry_end",
        success: event.success,
        attempt: event.attempt,
        finalError: event.finalError,
      };
  }
};

// ---------------------------------------------------------------------------
// Finished-result helpers
// ---------------------------------------------------------------------------

/**
 * @returns true if event is one of the four finished-result events
 */
export const isFinishedResponseEvent = (
  event: ResponseEvent,
): event is FinishedResponseEvent => {
  return (
    event.type === "tool_execution_end" ||
    (event.type === "message_update" &&
      (event.assistantMessageEvent.type === "text_end" ||
        event.assistantMessageEvent.type === "thinking_end" ||
        event.assistantMessageEvent.type === "toolcall_end"))
  );
};

/**
 * We get a stream of events from the Pi process, and this event indicates a single agent step is complete.
 * That is, the agent has produced a result over one or more turns and is ready for the next user input.
 */
export const isAgentStepComplete = (event: PiAgentSessionEvent): boolean => {
  return event.type === "agent_end";
};
