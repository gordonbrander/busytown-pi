import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type {
  AssistantMessageEvent,
  CompactionResult,
  ResponseEvent,
} from "./types.ts";

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

const mapAssistantMessageEvent = (
  e: PiAssistantMessageEvent,
): AssistantMessageEvent => {
  switch (e.type) {
    case "start":
      return { type: "start" };
    case "text_start":
      return { type: "text_start", contentIndex: e.contentIndex };
    case "text_delta":
      return { type: "text_delta", contentIndex: e.contentIndex, delta: e.delta };
    case "text_end":
      return { type: "text_end", contentIndex: e.contentIndex, content: e.content };
    case "thinking_start":
      return { type: "thinking_start", contentIndex: e.contentIndex };
    case "thinking_delta":
      return { type: "thinking_delta", contentIndex: e.contentIndex, delta: e.delta };
    case "thinking_end":
      return { type: "thinking_end", contentIndex: e.contentIndex, content: e.content };
    case "toolcall_start":
      return { type: "toolcall_start", contentIndex: e.contentIndex };
    case "toolcall_delta":
      return { type: "toolcall_delta", contentIndex: e.contentIndex, delta: e.delta };
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
        assistantMessageEvent: mapAssistantMessageEvent(event.assistantMessageEvent),
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

/**
 * We get a stream of events from the Pi process, and this event indicates a single agent step is complete.
 * That is, the agent has produced a result over one or more turns and is ready for the next user input.
 */
export const isAgentStepComplete = (event: PiAgentSessionEvent): boolean => {
  return event.type === "agent_end";
};
