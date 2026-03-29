import { type Event } from "../lib/event.ts";

export type RequestEvent = Event;

/**
 * A Pi RPC `prompt` command — what gets written to the Pi process stdin to
 * start an agent run.
 */
export type PromptCommand = { type: "prompt"; message: string };
export type AbortCommand = { type: "abort" };
export type PiRpcCommand = PromptCommand | AbortCommand;

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

// ---------------------------------------------------------------------------
// AgentProcess
// ---------------------------------------------------------------------------

/**
 * A stable handle to an agent for the lifetime of that agent. The underlying
 * OS process may be long-lived (Pi RPC) or spawned per-send (Claude CLI,
 * shell) — that is an implementation detail.
 *
 * `stream()` returns an `ReadableStream` that yields all response events for a
 * single agent run, completing when the run is done (`agent_end`). Callers
 * consume via `for-await-of`, which provides natural backpressure. Only one
 * `stream()` may be active at a time.
 */
export type SendOptions = {
  signal?: AbortSignal;
};

export type AgentProcess = {
  stream(request: RequestEvent, options?: SendOptions): ReadableStream<ResponseEvent>;
  alive: AbortSignal;
  kill(): Promise<void>;
};
