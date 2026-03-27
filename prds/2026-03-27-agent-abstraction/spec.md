# Agent Abstraction — Interface Specification

## Design Criteria

- **Thin abstraction**: The interface should be as minimal as sensible. Avoid layering
  concepts that don't add value.
- **Implementation-agnostic**: The same interface covers all agent backends:
  Pi RPC, `claude` CLI, and shell commands.
- **Long-lived handle**: An `AgentProcess` is a stable handle that the daemon holds for
  the lifetime of an agent. The underlying OS process may be long-lived (Pi RPC) or
  spawned per-send (Claude CLI, shell) — that is an implementation detail.
- **Persistent output stream**: Output is exposed as a single `ReadableStream` on the
  process handle, spanning all agent runs. Consumers can pipe, observe, or log it
  independently of the send/receive call site.
- **Backpressure via `send()`**: `send()` returns a `Promise<void>` that resolves when
  the agent run is complete. Callers `await send()` before sending the next message,
  enforcing one agent run at a time.
- **Streaming with ergonomic completion**: Events are streamed as they occur. Delta
  events carry only the incremental content (no accumulated state). Each delta type has
  a corresponding `_end` event that carries the complete, assembled content — so
  consumers that don't need live streaming can simply ignore deltas and handle end events.
- **Pi-aligned vocabulary and event shapes**: Terminology and event type names follow
  Pi's conventions (`agent_start`/`agent_end`, `turn_start`/`turn_end`,
  `tool_execution_*`, etc.). Event shapes are trimmed to remove redundant fields that
  Pi carries for its own internal purposes.
- **Per-run cancellation**: An `AbortSignal` passed to `send()` cancels the in-flight
  agent run without tearing down the agent process. The process remains alive and ready
  to accept the next `send()`. This is distinct from `dispose()`, which shuts the
  process down entirely.
- **Web Streams**: Prefer the Web Streams API (`ReadableStream`) over Node.js streams.

---

## Terminology

Aligned with Pi's terminology:

- **Agent run**: One full cycle of `send()` → agent processes → agent stops. Bounded by
  `agent_start` / `agent_end`. An agent run may involve multiple turns.
- **Turn**: One LLM call and its associated tool executions, within an agent run. Bounded
  by `turn_start` / `turn_end`.

---

## Event Types

```typescript
type AgentRunEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "text_delta";            delta: string }
  | { type: "text_end";              content: string }
  | { type: "thinking_delta";        delta: string }
  | { type: "thinking_end";          content: string }
  | { type: "tool_execution_start";  toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; partialResult: unknown }
  | { type: "tool_execution_end";    toolCallId: string; isError: boolean; result: unknown }
  | { type: "turn_end" }
  | { type: "agent_end" }
```

### Event semantics

| Event | Description |
|---|---|
| `agent_start` | Agent run has begun processing a message |
| `turn_start` | A new LLM call is starting within the agent run |
| `text_delta` | Incremental text chunk from the LLM response |
| `text_end` | LLM text block complete; `content` is the full assembled text |
| `thinking_delta` | Incremental thinking/reasoning chunk |
| `thinking_end` | Thinking block complete; `content` is the full assembled thinking |
| `tool_execution_start` | LLM has dispatched a tool call; `args` is the complete input |
| `tool_execution_update` | Streaming partial output from an in-progress tool execution |
| `tool_execution_end` | Tool execution complete; `result` is the full output |
| `turn_end` | LLM call and all its tool executions are complete |
| `agent_end` | Agent run is complete; `send()` resolves after this event |

### Notes on deltas vs end events

- `text_delta` / `thinking_delta`: carry only `delta` — the incremental content.
  No accumulated partial state is included.
- `text_end` / `thinking_end`: carry the complete `content`, assembled from all
  preceding deltas. Consumers that don't need streaming can ignore deltas entirely
  and handle only end events.
- `tool_execution_update`: carries only `toolCallId` and `partialResult`. `toolName`
  and `args` are omitted — they are already known from the preceding
  `tool_execution_start` and can be correlated via `toolCallId`.
- `tool_execution_end`: carries `toolCallId`, `isError`, and `result`. `toolName` is
  omitted as redundant.
- `turn_end` and `agent_end`: carry no payload. The full message and tool result data
  that Pi includes on these events is omitted — consumers can reconstruct from the
  preceding stream events if needed.

### Event sequence

A well-formed agent run always begins with `agent_start` and ends with `agent_end`.
Within a run, each turn begins with `turn_start` and ends with `turn_end`. A minimal
single-turn run looks like:

```
agent_start
  turn_start
    text_delta · text_delta · text_delta
    text_end
    tool_execution_start
    tool_execution_update · tool_execution_update
    tool_execution_end
    text_delta · text_delta
    text_end
  turn_end
agent_end
```

For implementations without LLM turns (e.g. shell agents), the run degenerates to a
single turn with text events:

```
agent_start
  turn_start
    text_end
  turn_end
agent_end
```

---

## AgentProcess Interface

```typescript
type AgentProcess = {
  readonly id: string
  readonly output: ReadableStream<AgentRunEvent>
  send(message: string, abort?: AbortSignal): Promise<void>
  dispose(): Promise<void>
}
```

### `id`

Stable identifier for this agent process. Matches the agent's configured ID.

### `output`

A persistent `ReadableStream<AgentRunEvent>` that emits events for all agent runs,
in order. The stream remains open for the lifetime of the process. Consumers can
read from it independently — e.g. for progress reporting, logging, or UI updates —
without coordinating with the send/receive call site.

### `send(message, abort?)`

Sends a message to the agent and returns a `Promise<void>` that resolves when the
agent run is complete (i.e. after `agent_end` has been emitted on `output`).

The resolved promise is the backpressure mechanism: callers `await send()` before
sending the next message, ensuring one agent run at a time.

#### Abort

Passing an `AbortSignal` cancels the in-flight agent run without shutting down the
agent process. The process remains alive and ready to accept the next `send()`. The
`output` stream will still emit `agent_end` after cancellation (possibly with partial
output), and `send()` will resolve normally.

Abort behaviour is implementation-specific:

- **Pi RPC**: sends `{"type": "abort"}` over the RPC connection. Pi cancels the
  current streaming operation and emits `agent_end`, leaving the session intact for
  the next run.
- **Claude CLI / Shell**: sends `SIGTERM` to the subprocess. Since these
  implementations spawn a fresh subprocess per `send()` call, the process is already
  gone by the next run regardless.

### `dispose()`

Shuts down the agent process entirely and closes the `output` stream. This is
distinct from per-run abort: `dispose()` is permanent teardown. Awaiting `dispose()`
ensures all cleanup is complete.

---

## Usage Patterns

### Observe output and drive sequentially

```typescript
// Observe the output stream independently
observeAgentOutput(process.output)

// Drive the agent with backpressure — await ensures one run at a time
await process.send(JSON.stringify(event1), signal)
await process.send(JSON.stringify(event2), signal)
```

### Simple consumer (end events only, no streaming)

```typescript
for await (const event of process.output) {
  switch (event.type) {
    case "text_end":           console.log(event.content); break
    case "tool_execution_end": console.log("tool result", event.result); break
    case "turn_end":           console.log("--- turn complete ---"); break
    case "agent_end":          console.log("=== run complete ==="); break
  }
}
```

### Streaming consumer (delta events)

```typescript
for await (const event of process.output) {
  if (event.type === "text_delta") process.stdout.write(event.delta)
  if (event.type === "tool_execution_start") console.log(`[${event.toolName}]`)
  if (event.type === "tool_execution_update") process.stdout.write(String(event.partialResult))
}
```
