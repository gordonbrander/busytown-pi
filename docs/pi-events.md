# Agent Response Events

All `ResponseEvent` values emitted by `AgentProcess.send()` as an agent run
proceeds. The types are defined in [`types.ts`](./types.ts).

---

## Event hierarchy

An agent run is bounded by `agent_start` / `agent_end`. Within a run there
are one or more turns, each bounded by `turn_start` / `turn_end`. A turn is
one LLM request/response cycle plus any tool executions triggered by that
response. Multiple turns happen when the LLM invokes tools and loops, or
when steering messages are queued. Within a turn, the assistant message is
bounded by `message_start` / `message_end`, followed by tool executions.

```
agent_start
  [compaction_start / compaction_end]   ← may occur at any point
  [auto_retry_start / auto_retry_end]   ← may occur at any point

  turn_start
    message_start
      message_update { start }
      message_update { text_start }
      message_update { text_delta } ...
      message_update { text_end }          ← full text content assembled
      message_update { thinking_start }
      message_update { thinking_delta } ...
      message_update { thinking_end }      ← full thinking content assembled
      message_update { toolcall_start }
      message_update { toolcall_delta } ...
      message_update { toolcall_end }      ← tool call args fully received
      message_update { done / error }
    message_end

    tool_execution_start                   ← tool begins executing
    tool_execution_update ...              ← streaming partial output
    tool_execution_end                     ← full result available

  turn_end

  [additional turns if agent calls more tools or receives steering messages]

agent_end
```

> **Note:** `text_*`, `thinking_*`, and `toolcall_*` blocks may appear in
> any order and may repeat within a single message. `contentIndex`
> distinguishes parallel blocks of the same type.

---

## Minimal consumer guide

For each conceptual output, the table below lists the single event you need
to handle to get the finished result. You can ignore every other event in
that category.

| What you want                | Event to handle                                                        | Key fields                                                   |
| ---------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| Finished text from the LLM   | `message_update` where `assistantMessageEvent.type === "text_end"`     | `assistantMessageEvent.content` — full assembled text        |
| Finished thinking/reasoning  | `message_update` where `assistantMessageEvent.type === "thinking_end"` | `assistantMessageEvent.content` — full assembled thinking    |
| Tool call the LLM dispatched | `message_update` where `assistantMessageEvent.type === "toolcall_end"` | `assistantMessageEvent.toolCall` — `{ id, name, arguments }` |
| Tool execution result        | `tool_execution_end`                                                   | `toolCallId`, `isError`, `result`                            |
| Turn complete                | `turn_end`                                                             | `message`, `toolResults`                                     |
| Run complete                 | `agent_end`                                                            | `messages` — all messages from the run                       |

### Minimal consumer example

```typescript
for await (const event of agent.send(incomingEvent)) {
  if (event.type !== "message_update" && event.type !== "tool_execution_end") {
    continue;
  }
  if (event.type === "tool_execution_end") {
    console.log("tool result", event.toolCallId, event.result);
    continue;
  }
  const sub = event.assistantMessageEvent;
  switch (sub.type) {
    case "text_end":
      console.log("text", sub.content);
      break;
    case "thinking_end":
      console.log("thinking", sub.content);
      break;
    case "toolcall_end":
      console.log("tool call", sub.toolCall.name, sub.toolCall.arguments);
      break;
  }
}
```

---

## Full event reference

### `agent_start`

The agent has begun processing the sent event. Marks the start of an agent
run.

### `agent_end`

The agent run is complete. The `send()` stream closes after this event.
Fields:

- `messages` — all messages from the run

---

### `turn_start`

A new turn is starting within the run. Each turn is one LLM API call plus
any tool executions triggered by that response. Includes `turnIndex`
(zero-based).

### `turn_end`

The turn is complete. Fields:

- `message` — the assistant's response message for this turn
- `toolResults` — array of all tool results from this turn

---

### `message_start`

An assistant message has begun streaming.

### `message_update`

Carries one `assistantMessageEvent` sub-event describing a streaming
increment of the assistant message. Sub-event types:

| Sub-event type   | Description                              | Key fields                                             |
| ---------------- | ---------------------------------------- | ------------------------------------------------------ |
| `start`          | Message generation started               | —                                                      |
| `text_start`     | A text block has begun                   | `contentIndex`                                         |
| `text_delta`     | Incremental text chunk                   | `contentIndex`, `delta`                                |
| `text_end`       | Text block complete                      | `contentIndex`, `content` (full text)                  |
| `thinking_start` | A thinking/reasoning block has begun     | `contentIndex`                                         |
| `thinking_delta` | Incremental thinking chunk               | `contentIndex`, `delta`                                |
| `thinking_end`   | Thinking block complete                  | `contentIndex`, `content` (full thinking)              |
| `toolcall_start` | LLM has begun emitting a tool call       | `contentIndex`                                         |
| `toolcall_delta` | Incremental tool call arguments chunk    | `contentIndex`, `delta`                                |
| `toolcall_end`   | Tool call fully received from LLM        | `contentIndex`, `toolCall` (`id`, `name`, `arguments`) |
| `done`           | Message generation finished normally     | `reason`: `"stop"` \| `"length"` \| `"toolUse"`        |
| `error`          | Message generation failed or was aborted | `reason`: `"aborted"` \| `"error"`                     |

`contentIndex` is the index of the content block within the assistant
message. Use it to associate `*_start` / `*_delta` / `*_end` triples with
each other when a message contains multiple blocks of the same type.

### `message_end`

The assistant message is complete.

---

### `tool_execution_start`

The agent has begun executing a tool. Fields:

- `toolCallId` — correlate with subsequent update/end events and with
  `toolcall_end.toolCall.id` from the message stream
- `toolName` — name of the tool
- `args` — full validated arguments

### `tool_execution_update`

Streaming partial output from an in-progress tool execution. `partialResult`
is the accumulated output so far (not just the latest chunk) — consumers can
simply replace their current display on each update. Correlate via
`toolCallId`.

### `tool_execution_end`

Tool execution complete. Fields:

- `toolCallId` — correlates with `tool_execution_start`
- `isError` — whether the tool reported an error
- `result` — the full result

---

### `compaction_start`

Compaction has begun. `reason` is one of:

- `"manual"` — triggered explicitly (e.g. via the RPC `compact` command)
- `"threshold"` — context is getting large; auto-compaction kicked in
- `"overflow"` — context exceeded the limit; compaction is required before
  the run can continue

### `compaction_end`

Compaction is complete. Fields:

- `reason` — same values as `compaction_start`
- `result` — compaction summary and token stats, or `undefined` if aborted
  or failed
- `aborted` — true if compaction was cancelled
- `willRetry` — true when `reason` was `"overflow"` and compaction succeeded;
  the agent will automatically retry the last prompt
- `errorMessage` — present when compaction failed (not aborted)

---

### `auto_retry_start`

The agent encountered a transient error (overloaded, rate limit, 5xx) and is
waiting before retrying. Fields: `attempt`, `maxAttempts`, `delayMs`,
`errorMessage`.

### `auto_retry_end`

A retry cycle has concluded. `success` indicates whether the retry succeeded.
On final failure, `finalError` contains the last error message.

---

## References

### Source code (in `node_modules`)

- **Type definitions** — `@mariozechner/pi-agent-core/dist/types.d.ts`
  (`AgentEvent`, `AssistantMessageEvent`, and related types)
- **Agent loop** — `@mariozechner/pi-agent-core/dist/agent-loop.js`
  (emits `agent_start`/`agent_end`, `turn_start`/`turn_end`, drives the
  multi-turn tool-use loop)
- **Agent session** — `@mariozechner/pi-coding-agent/dist/core/agent-session.js`
  (wraps raw events with `turnIndex` and `timestamp`)

### Documentation

- **pi-agent-core README** — `@mariozechner/pi-agent-core/README.md`
  (event flow diagrams and event type reference)
- **Pi mono-repo** — <https://github.com/badlogic/pi-mono>
  (`packages/agent` for pi-agent-core, `packages/coding-agent` for
  pi-coding-agent)
