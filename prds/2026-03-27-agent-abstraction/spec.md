# Agent Abstraction — Interface Specification

## Design Criteria

- **Thin abstraction**: The interface should be as minimal as sensible. Avoid layering concepts that don't add value.
- **Implementation-agnostic**: The same interface covers all agent backends: Pi RPC, `claude` CLI, and shell commands.
- **Long-lived handle**: An `AgentProcess` is a stable handle that the daemon holds for the conceptual lifetime of an agent. The underlying OS process may be long-lived (Pi RPC) or spawned per-send (Claude CLI, shell) — that is an implementation detail.
- **AsyncIterable output**: `send()` returns an `AsyncIterable` — an async generator that yields events for a single agent run, completing when the run is done (`agent_end`). Callers consume via `for-await-of`, which provides natural backpressure and a clear step boundary.
- **Sequential by construction**: Only one `send()` can be active at a time. The async generator holds the single stdout reader; the caller's `for-await-of` must finish before the next `send()`. A runtime `busy` flag guards against accidental concurrent calls.
- **Streaming with ergonomic completion**: Events are streamed as they occur. Delta events carry only the incremental content (no accumulated state). Each delta type has a corresponding `_end` event that carries the complete, assembled content — so consumers that don't need live streaming can simply ignore deltas and handle end events.
- **Pi-aligned vocabulary and event shapes**: Terminology and event type names follow Pi's conventions (`agent_start`/`agent_end`, `turn_start`/`turn_end`, `tool_execution_*`, etc.). Event shapes are trimmed to remove redundant fields that Pi carries for its own internal purposes.
- **Web Streams internally**: The underlying stdout pipe uses Web Streams (`ReadableStream`), but the public API surface is `AsyncIterable` — simpler to consume and compose.

---

## Terminology

Aligned with Pi's terminology:

- **Agent run**: One full cycle of `send()` → agent processes → agent stops. Bounded by `agent_start` / `agent_end`. An agent run may involve multiple turns.
- **Turn**: One LLM request/response cycle, including any tool calls made in that response. Multiple turns happen per user prompt when the LLM invokes tools and loops. Bounded by `turn_start` / `turn_end`.

---

## Event Types

```typescript
type AgentResponseEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "text_delta"; delta: string }
  | { type: "text_end"; content: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_end"; content: string }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      isError: boolean;
      result: unknown;
    }
  | { type: "turn_end" }
  | { type: "agent_end" };
```

### Agent response event semantics

| Event                   | Description                                                       |
| ----------------------- | ----------------------------------------------------------------- |
| `agent_start`           | Agent run has begun processing a message                          |
| `turn_start`            | A new LLM call is starting within the agent run                   |
| `text_delta`            | Incremental text chunk from the LLM response                      |
| `text_end`              | LLM text block complete; `content` is the full assembled text     |
| `thinking_delta`        | Incremental thinking/reasoning chunk                              |
| `thinking_end`          | Thinking block complete; `content` is the full assembled thinking |
| `tool_execution_start`  | LLM has dispatched a tool call; `args` is the complete input      |
| `tool_execution_update` | Streaming partial output from an in-progress tool execution       |
| `tool_execution_end`    | Tool execution complete; `result` is the full output              |
| `turn_end`              | LLM call and all its tool executions are complete                 |
| `agent_end`             | Agent run is complete; async generator returns after this event   |

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
  send(event: Event): AsyncIterable<AgentResponseEvent>;
  isAlive(): boolean;
  kill(): Promise<void>;
};
```

### `send(event)`

Sends a message to the agent and returns an `AsyncIterable` that yields all response
events for that agent run (`agent_start` through `agent_end`).

The iterable completes when the agent run is done. This means consumers can process
events from the queue in a step-wise fashion with natural backpressure:

```typescript
while (true) {
  const event = await claimNextEvent(queue);
  for await (const res of agent.send(event)) {
    // handle streaming events
  }
  // loop naturally blocks — next event only after agent_end
}
```

#### Concurrency guard

Only one `send()` may be active at a time. Calling `send()` while a previous
iteration is still in progress throws an error. This is enforced by a simple `busy`
boolean flag — the only concurrency state needed.

#### Implementation sketch (Pi RPC)

The Pi RPC implementation holds a single `ReadableStreamDefaultReader` on stdout for
the process lifetime. Each `send()` writes to stdin, then yields from the shared
reader until `agent_end`:

```typescript
const reader = output.getReader();
let busy = false;

const send = async function* (
  event: RequestEvent,
): AsyncGenerator<ResponseEvent> {
  if (busy) throw new Error("concurrent send — previous step not finished");
  busy = true;
  try {
    await writeEvent(event);
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new ExitError("Pi process exited unexpectedly");
      yield value;
      if (value.type === "agent_end") return;
    }
  } finally {
    busy = false;
  }
};
```

### `isAlive()`

Returns `true` if the underlying process is still running. Useful for checking
whether the agent can accept a new `send()` without attempting one.

### `kill()`

Shuts down the agent process entirely. This is distinct from per-run abort. `kill()`
is a permanent teardown. Awaiting `kill()` ensures all cleanup is complete.

---

## Usage Patterns

### Event queue consumer (primary use-case)

```typescript
while (agent.isAlive()) {
  const event = await claimNextEvent(queue);
  for await (const res of agent.send(event)) {
    switch (res.type) {
      case "text_end":
        console.log(res.content);
        break;
      case "tool_execution_end":
        console.log("tool result", res.result);
        break;
      case "turn_end":
        console.log("--- turn complete ---");
        break;
    }
  }
  // agent_end has been reached — safe to claim next event
}
```

### Streaming consumer (delta events)

```typescript
for await (const res of agent.send(event)) {
  if (res.type === "text_delta") process.stdout.write(res.delta);
  if (res.type === "tool_execution_start") console.log(`[${res.toolName}]`);
  if (res.type === "tool_execution_update")
    process.stdout.write(String(res.partialResult));
}
```
