# Pi RPC Mode

RPC mode lets you drive a Pi agent **headlessly** via a JSON protocol over **stdin/stdout**, making it suitable for embedding in other applications, IDEs, orchestration systems, or custom UIs.

### Starting It

```bash
pi --mode rpc [--provider anthropic] [--model claude-...] [--no-session]
```

---

## Core Protocol

The protocol is **JSONL** (one JSON object per line, `\n`-delimited):

| Direction          | Purpose                                          |
| ------------------ | ------------------------------------------------ |
| **stdin → agent**  | Commands (e.g. `prompt`, `abort`, `bash`)        |
| **agent → stdout** | Responses (`type: "response"`) + streamed Events |

**Important framing detail**: Split records on `\n` only — do NOT use Node's `readline` (it also splits on Unicode line separators `U+2028`/`U+2029`), which breaks the protocol.

Commands support an optional `id` field for request/response correlation:

```json
{ "id": "req-1", "type": "prompt", "message": "Hello!" }
// → {"id": "req-1", "type": "response", "command": "prompt", "success": true}
```

---

## Commands (stdin → agent)

**Prompting:**

- `prompt` — Send a user message. Returns immediately; agent streams events asynchronously. Supports images via base64.
- `steer` — Queue a mid-stream steering message (delivered after current tool calls finish, before next LLM call).
- `follow_up` — Queue a message to be delivered only after the agent fully finishes.
- `abort` — Cancel the current operation.
- `new_session` / `switch_session` / `fork` — Session management.

**State & config:**

- `get_state`, `get_messages`, `get_session_stats`
- `set_model`, `cycle_model`, `get_available_models`
- `set_thinking_level`, `cycle_thinking_level`
- `set_steering_mode`, `set_follow_up_mode`
- `compact`, `set_auto_compaction`
- `set_auto_retry`, `abort_retry`

**Bash:**

- `bash` — Run a shell command; output is injected into the conversation context on the **next prompt** (not immediately, no event emitted).

---

## Events (agent → stdout, async)

Events stream out during agent operation:

```
agent_start → turn_start → message_start → message_update (many) → message_end → tool_execution_start → tool_execution_update → tool_execution_end → turn_end → agent_end
```

Key events:

- **`message_update`** — Streaming deltas: `text_delta`, `thinking_delta`, `toolcall_delta`, etc.
- **`tool_execution_start/update/end`** — Tool call lifecycle; `partialResult` in updates is the **full accumulated output so far** (replace, don't append).
- **`agent_end`** — All messages generated in this run.
- **`auto_compaction_start/end`** — Triggered when context gets large.
- **`auto_retry_start/end`** — Triggered on transient API errors (rate limits, overloads).

---

## Mid-Stream Steering

The `prompt` command handles mid-stream scenarios via `streamingBehavior`:

```json
{
  "type": "prompt",
  "message": "Stop and do X instead",
  "streamingBehavior": "steer"
}
```

- `"steer"` — Delivers after current tool calls finish, before next LLM call.
- `"followUp"` — Waits until agent fully stops.
- If omitted while streaming → **error**.

Extension commands (e.g. `/mycommand`) bypass this and execute immediately even while streaming.

---

## Extension UI Sub-Protocol

Extensions can request interactive input even in RPC mode. This uses a nested request/response flow:

- **Dialog methods** (`select`, `confirm`, `input`, `editor`) → agent emits `extension_ui_request` on stdout; client must reply with `extension_ui_response` matching the `id`.
- **Fire-and-forget methods** (`notify`, `setStatus`, `setWidget`, `setTitle`) → agent emits `extension_ui_request` but expects no reply.

```json
// Agent → client:
{"type": "extension_ui_request", "id": "uuid-1", "method": "confirm", "title": "Clear session?", "timeout": 5000}

// Client → agent:
{"type": "extension_ui_response", "id": "uuid-1", "confirmed": true}
```

If a timeout is specified, the agent auto-resolves with a default if the client doesn't respond.

---

## Recommended Client Pattern

```javascript
// Use manual JSONL splitting, NOT readline:
stream.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const [line, ...rest] = buffer.split("\n");
    buffer = rest.join("\n");
    const event = JSON.parse(line.replace(/\r$/, ""));
    handle(event);
  }
});

// Send a prompt:
agent.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");
```

---

## Node.js Alternative

If you're writing a Node.js app, the docs recommend **using `AgentSession` directly** from `@mariozechner/pi-coding-agent` rather than spawning a subprocess — it's lower overhead and fully typed. The `rpc-client.ts` source also provides a ready-made typed subprocess client.
