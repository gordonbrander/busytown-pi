# `pi --mode json` Message Format

## Overview

```bash
pi --mode json "Your prompt"
```

Outputs all session events as **newline-delimited JSON** (JSON Lines) to stdout — one JSON object per line. Useful for integrating pi into other tools or automated pipelines.

The format is produced by two composing layers:

- **`pi-ai`** — the low-level LLM streaming protocol (`AssistantMessageEvent`)
- **`pi-agent-core`** — the agent lifecycle layer (`AgentEvent`) that wraps the above

Understanding this layering is the key to making sense of the apparent redundancy in the output (covered below).

---

## Line-by-line Structure

### First line: Session header

```json
{
  "type": "session",
  "version": 3,
  "id": "<uuid>",
  "timestamp": "<iso8601>",
  "cwd": "/path/to/cwd"
}
```

### Subsequent lines: Events

One JSON object per event, in emission order.

---

## Event Reference

### Agent lifecycle

```json
{"type":"agent_start"}
{"type":"agent_end","messages":[...]}
```

- `agent_start` fires when the agent begins processing a prompt.
- `agent_end` fires when the agent is fully done (all turns and follow-ups complete). `messages` is the array of **all new messages** added during this agent run (user, assistant, and tool results).

### Turn lifecycle

A "turn" is one LLM response plus the tool calls it triggers.

```json
{"type":"turn_start"}
{"type":"turn_end","message":{...},"toolResults":[...]}
```

- `turn_end.message` is the completed `AssistantMessage` for this turn.
- `turn_end.toolResults` is an array of `ToolResultMessage` objects for every tool call made during this turn.

### Message lifecycle (streaming assistant response)

```json
{"type":"message_start","message":{...}}
{"type":"message_update","message":{...},"assistantMessageEvent":{...}}
{"type":"message_end","message":{...}}
```

- `message_start` fires when a new LLM response begins streaming. `message` is the initial (empty) `AssistantMessage`.
- `message_update` fires for every streaming chunk. See below for the `assistantMessageEvent` sub-protocol.
- `message_end` fires when the LLM response is fully received. `message` is the completed `AssistantMessage`.

### Tool execution

```json
{"type":"tool_execution_start","toolCallId":"...","toolName":"bash","args":{...}}
{"type":"tool_execution_update","toolCallId":"...","toolName":"bash","args":{...},"partialResult":{...}}
{"type":"tool_execution_end","toolCallId":"...","toolName":"bash","result":{...},"isError":false}
```

- `tool_execution_start` fires when a tool call begins.
- `tool_execution_update` fires for streaming tool output (not all tools stream).
- `tool_execution_end` fires when the tool call completes. `isError` is `true` if the tool returned an error result.

### Session management events

```json
{"type":"auto_compaction_start","reason":"threshold"}
{"type":"auto_compaction_end","result":{...},"aborted":false,"willRetry":false,"errorMessage":"..."}

{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":1000,"errorMessage":"..."}
{"type":"auto_retry_end","success":true,"attempt":1,"finalError":"..."}
```

---

## The `assistantMessageEvent` Sub-Protocol

The `assistantMessageEvent` field in `message_update` uses the `AssistantMessageEvent` type from the `pi-ai` layer. It is a tagged union covering the full streaming lifecycle of one LLM response:

```typescript
type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "text_end";
      contentIndex: number;
      content: string;
      partial: AssistantMessage;
    }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "thinking_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "thinking_end";
      contentIndex: number;
      content: string;
      partial: AssistantMessage;
    }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: ToolCall;
      partial: AssistantMessage;
    }
  | {
      type: "done";
      reason: "stop" | "length" | "toolUse";
      message: AssistantMessage;
    }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };
```

**Key design principle:** Every sub-event carries `partial: AssistantMessage` — the full message as built up so far. This makes each event self-contained: a consumer can process any event in isolation without accumulating deltas.

---

## Message Types

### `UserMessage`

```typescript
{
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}
```

### `AssistantMessage`

```typescript
{
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: {...} };
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}
```

### `ToolResultMessage`

```typescript
{
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: any;
  isError: boolean;
  timestamp: number;
}
```

### Extended message types (coding-agent layer)

These appear in `agent_end.messages` and in `session.messages` but are less common in the event stream:

- `BashExecutionMessage` — records a bash command run directly via the pi TUI (not via the bash tool)
- `CustomMessage` — application-defined messages injected by extensions
- `BranchSummaryMessage` — summary of a pruned session branch
- `CompactionSummaryMessage` — summary produced by context compaction

---

## Redundancy Explained

The output contains deliberate redundancy arising from the two-layer architecture. Here is a map of every overlap:

### `message_update.message` === `message_update.assistantMessageEvent.partial`

The `pi-agent-core` layer adds a top-level `message` field to `message_update` so that all three lifecycle events (`message_start`, `message_update`, `message_end`) have the same shape — consumers can always read `event.message`. But `message` is the same object as `assistantMessageEvent.partial`, so the full partial message appears **twice** in every `message_update` line.

### `message_end.message` === `turn_end.message`

When a turn has no tool calls (or after the last tool call), `message_end` fires immediately before `turn_end`. Both carry the same completed `AssistantMessage`.

### `turn_end.message` and `turn_end.toolResults` ⊂ `agent_end.messages`

`agent_end.messages` is the full set of new messages produced during the agent run. Every `AssistantMessage` from every `turn_end.message`, and every `ToolResultMessage` from every `turn_end.toolResults`, will appear in this array.

### `tool_execution_end.result` === corresponding entry in `turn_end.toolResults`

Each `ToolResultMessage` in `turn_end.toolResults` is the same data that was emitted earlier in the corresponding `tool_execution_end` event.

### Summary table

| Field                    | Same data also in                                            |
| ------------------------ | ------------------------------------------------------------ |
| `message_update.message` | `message_update.assistantMessageEvent.partial`               |
| `message_end.message`    | `turn_end.message`                                           |
| `turn_end.message`       | `agent_end.messages[]`                                       |
| `turn_end.toolResults[]` | `agent_end.messages[]` and prior `tool_execution_end` events |

---

## Practical Consumption Guide

For most use cases you only need a small subset of the stream.

**Stream text as it arrives:**

```bash
pi --mode json "prompt" 2>/dev/null \
  | jq -rj 'select(.assistantMessageEvent.type == "text_delta") | .assistantMessageEvent.delta'
```

**Get the final completed response:**

```bash
pi --mode json "prompt" 2>/dev/null \
  | jq -c 'select(.type == "message_end")'
# message_end.message is the full AssistantMessage
```

**Get tool call results:**

```bash
pi --mode json "prompt" 2>/dev/null \
  | jq -c 'select(.type == "tool_execution_end")'
```

**Get everything that was added to the conversation (after completion):**

```bash
pi --mode json "prompt" 2>/dev/null \
  | jq -c 'select(.type == "agent_end") | .messages[]'
```

### Recommended event subset by use case

| Goal                      | Use                                                                                                     | Ignore                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Stream output text        | `message_update` where `assistantMessageEvent.type == "text_delta"`, read `assistantMessageEvent.delta` | `message` field on same event         |
| Final response text       | `message_end.message`                                                                                   | `turn_end`, `agent_end`               |
| Tool call results         | `tool_execution_end`                                                                                    | `turn_end.toolResults`                |
| Full conversation history | `agent_end.messages`                                                                                    | all prior per-message/per-tool events |
| Thinking output           | `message_update` where `assistantMessageEvent.type == "thinking_delta"`                                 | —                                     |
