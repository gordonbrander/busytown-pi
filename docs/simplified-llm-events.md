# Simplified Events

A simplified event model for agent turns, abstracting over the Anthropic,
OpenAI, and Pi streaming APIs. Skips deltas and emits one event per major
stage. We persist this to the event queue in the form of `agent.<id>.messages` events.

## Design goals

- One event per logical stage (no streaming deltas)
- Start/end pairs for content generation (enables spinners)
- Tool call IDs to correlate tool_call and tool_result
- A "turn" encompasses the full loop from user message through all tool call
  rounds to final response
- User message id becomes the `correlation_id` carried by all subsequent
  turn events

## Event types

All events within a run carry a `correlation_id` field that matches
the originating `user_message` id, for correlating events back to the
request that generated them.

| Event                | Key fields                                                          |
| -------------------- | ------------------------------------------------------------------- |
| `user_message`       | `id`, content                                                       |
| `agent_start`        | `correlation_id`                                                    |
| `turn_start`         | `correlation_id`                                                    |
| `thinking_start`     | `correlation_id`, `contentIndex`                                    |
| `thinking_end`       | `correlation_id`, `contentIndex`, text                              |
| `text_start`         | `correlation_id`, `contentIndex`                                    |
| `text_end`           | `correlation_id`, `contentIndex`, text                              |
| `toolcall_start`     | `correlation_id`, `contentIndex`, `tool_call_id`, name              |
| `toolcall_end`       | `correlation_id`, `contentIndex`, `tool_call_id`, name, args        |
| `tool_execution_end` | `correlation_id`, `tool_call_id`, output/error                      |
| `error`              | `correlation_id`, error details                                     |
| `turn_end`           | `correlation_id`, input_tokens, output_tokens                       |
| `compaction_start`   | `correlation_id`, reason (`manual` / `threshold` / `overflow`)      |
| `compaction_end`     | `correlation_id`, reason, result, aborted, willRetry                |
| `auto_retry_start`   | `correlation_id`, attempt, maxAttempts, delayMs, errorMessage       |
| `auto_retry_end`     | `correlation_id`, success, finalError                               |
| `agent_end`          | `correlation_id`, messages, total_input_tokens, total_output_tokens |

## Lifecycle

An agent run is bounded by `agent_start` / `agent_end`. Within a run there
are one or more turns, each bounded by `turn_start` / `turn_end`. A turn is
one LLM API call plus any tool executions triggered by that response. Multiple
turns happen when the LLM invokes tools and loops.

The user message originates an ID that becomes the `correlation_id` on
all subsequent events. Within a turn, events flow in whatever order the
model produces them. Start/end pairs may repeat, and tool calls may be
parallel. `contentIndex` distinguishes parallel blocks of the same type
within a single message.

`compaction_start` / `compaction_end` and `auto_retry_start` /
`auto_retry_end` may occur at any point during a run.

A typical multi-tool run:

```
user_message(id:"msg_1")
agent_start(correlation_id:"msg_1")

  turn_start(correlation_id:"msg_1")
  thinking_start(correlation_id:"msg_1", contentIndex:0)
  thinking_end(correlation_id:"msg_1", contentIndex:0, text:"...")
  text_start(correlation_id:"msg_1", contentIndex:1)
  text_end(correlation_id:"msg_1", contentIndex:1, text:"...")
  toolcall_start(correlation_id:"msg_1", contentIndex:2, tool_call_id:"tc_1", name:"search")
  toolcall_start(correlation_id:"msg_1", contentIndex:3, tool_call_id:"tc_2", name:"read_file")
  toolcall_end(correlation_id:"msg_1", contentIndex:2, tool_call_id:"tc_1", name:"search", args:{...})
  toolcall_end(correlation_id:"msg_1", contentIndex:3, tool_call_id:"tc_2", name:"read_file", args:{...})
  tool_execution_end(correlation_id:"msg_1", tool_call_id:"tc_1", output:"...")
  tool_execution_end(correlation_id:"msg_1", tool_call_id:"tc_2", output:"...")
  turn_end(correlation_id:"msg_1", input_tokens:1200, output_tokens:85)

  turn_start(correlation_id:"msg_1")
  thinking_start(correlation_id:"msg_1", contentIndex:0)
  thinking_end(correlation_id:"msg_1", contentIndex:0, text:"...")
  text_start(correlation_id:"msg_1", contentIndex:1)
  text_end(correlation_id:"msg_1", contentIndex:1, text:"...")
  turn_end(correlation_id:"msg_1", input_tokens:2800, output_tokens:150)

agent_end(correlation_id:"msg_1", total_input_tokens:4000, total_output_tokens:235)
```

A simple single-turn run:

```
user_message(id:"msg_1")
agent_start(correlation_id:"msg_1")
  turn_start(correlation_id:"msg_1")
  thinking_start(correlation_id:"msg_1", contentIndex:0)
  thinking_end(correlation_id:"msg_1", contentIndex:0, text:"...")
  text_start(correlation_id:"msg_1", contentIndex:1)
  text_end(correlation_id:"msg_1", contentIndex:1, text:"...")
  turn_end(correlation_id:"msg_1", input_tokens:1000, output_tokens:50)
agent_end(correlation_id:"msg_1", total_input_tokens:1000, total_output_tokens:50)
```

## API mapping

### Anthropic

- `thinking_start/end` maps to `content_block_start/stop` with
  type `thinking`
- `assistant_text_start/end` maps to `content_block_start/stop` with
  type `text`
- `toolcall_start` maps to `content_block_start` with type `tool_use`
  (provides id and tool name immediately)
- `toolcall_end` maps to `content_block_stop` (args fully accumulated
  from deltas)

### OpenAI

- `thinking_start/end` maps to reasoning content in streaming
  chunks (start signaled by first chunk, end by completion)
- `assistant_text_start/end` maps to content deltas (start signaled
  by first chunk, end by `finish_reason`)
- `toolcall_start` maps to first tool call chunk (provides name early)
- `toolcall_end` maps to completed tool call (args fully accumulated)

### Pi

Pi's `ResponseEvent` stream is a superset of the simplified events — it
includes streaming deltas and a `message_update` envelope that the simplified
model omits.

#### Structural differences

| Concept          | Simplified                              | Pi                                                      |
| ---------------- | --------------------------------------- | ------------------------------------------------------- |
| Granularity      | Coalesced — no deltas, just start/end   | Streaming — full start/delta/end triples                |
| Message wrapper  | None — content events are turn children | `message_start` / `message_update` / `message_end`      |
| Content delivery | `text_end` carries full text directly   | `message_update` sub-event with `text_end` carries text |
| Tool execution   | Single `tool_execution_end`             | `tool_execution_start` / `_update` / `_end` (streaming) |
| Correlation      | `correlation_id` on every event         | Implicit via nesting within the `agent.send()` stream   |
| Token accounting | On `turn_end` and `agent_end`           | On `turn_end` or left to the consumer                   |

#### Event mapping

| Simplified Event       | Pi Event(s)                                                                                              | Notes                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `user_message`         | _(implicit — event passed to `send()`)_                                                                  | Simplified makes this explicit with an `id` → `correlation_id`                                      |
| `agent_start`          | `agent_start`                                                                                            | Same                                                                                                |
| `agent_end`            | `agent_end`                                                                                              | Both carry `messages`; simplified adds total token counts                                           |
| `turn_start`           | `turn_start`                                                                                             | Pi adds `turnIndex`                                                                                 |
| `turn_end`             | `turn_end`                                                                                               | Simplified carries tokens; Pi carries `message` + `toolResults`                                     |
| `thinking_start`       | `message_update { thinking_start }`                                                                      | Same content, different envelope                                                                    |
| `thinking_end`         | `message_update { thinking_end }`                                                                        | Both carry full assembled text                                                                      |
| `text_start`           | `message_update { text_start }`                                                                          | Same                                                                                                |
| `text_end`             | `message_update { text_end }`                                                                            | Both carry full assembled text                                                                      |
| `toolcall_start`       | `message_update { toolcall_start }`                                                                      | Simplified includes `tool_call_id` and `name` upfront                                               |
| `toolcall_end`         | `message_update { toolcall_end }`                                                                        | Both carry name + args; Pi nests under `toolCall` object                                            |
| `tool_execution_end`   | `tool_execution_end`                                                                                     | Both carry `tool_call_id`, output/error                                                             |
| `error`                | `message_end { message.stopReason: "error" \| "aborted" }` (also `message_update { error }` defensively) | Pi reports failed/aborted LLM calls by setting `stopReason` and `errorMessage` on the final message |
| `compaction_start/end` | `compaction_start/end`                                                                                   | Same fields                                                                                         |
| `auto_retry_start/end` | `auto_retry_start/end`                                                                                   | Same fields                                                                                         |

Pi events with no simplified equivalent: `message_start`, successful
`message_end`, `message_update { start }`, `message_update { done }`, all
`*_delta` events, `tool_execution_start`, and `tool_execution_update`.
