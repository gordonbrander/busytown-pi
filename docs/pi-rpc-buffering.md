# Pi RPC Mode: Stdin Buffering and Message Processing

## Summary

Pi's RPC mode processes stdin messages **sequentially**. It reads one JSONL
message, fully processes it (awaiting the entire agent run), then reads the
next. You can safely write multiple messages to stdin — they queue in the OS
pipe buffer and Pi consumes them one at a time.

## How Pi reads stdin

Pi uses a custom JSONL line reader (`attachJsonlLineReader`), not Node's
`readline` module. This is intentional — Node's `readline` splits on Unicode
line separators (U+2028, U+2029) which can appear inside JSON strings. Pi's
reader splits strictly on `\n` only.

The reader attaches a `data` listener to `process.stdin`, accumulates bytes in
a buffer via `StringDecoder`, and emits complete lines to a callback.

## Sequential processing

The core loop in `rpc-mode.js`:

```javascript
const handleInputLine = async (line) => {
  const command = JSON.parse(line);
  const response = await handleCommand(command); // blocks until agent run completes
  output(response);
  await checkShutdownRequested();
};
```

The callback is invoked as `void handleInputLine(line)` — each invocation
awaits `handleCommand()` before the next line is processed. This means:

1. Client writes a JSONL command to stdin
2. Pi reads the line and calls `handleInputLine()`
3. `handleCommand()` runs the full agent step (can take seconds/minutes)
4. Response is written to stdout
5. Only then does Pi process the next buffered line

## Event streaming is independent

While a command is being processed, Pi streams events to stdout via a
subscription:

```javascript
session.subscribe((event) => output(event));
```

These events (agent*start, text_delta, tool_execution*\*, agent_end, etc.)
flow asynchronously and do not block stdin reading. Stdout carries both
streaming events and command responses on the same JSONL channel.

## Extension UI requests

There is one special message type that breaks the strict request/response
pattern: `extension_ui_response`. These are replies to Pi-initiated
`extension_ui_request` events and are handled separately — they resolve a
pending promise and do not generate a command response. This allows
bidirectional communication during an agent run.

## Implications for busytown-pi

Even though Pi queues messages correctly, busytown-pi still uses step-wise
`send()` → consume until `agent_end` → next send for three reasons:

1. **Stdout must be drained** — if the consumer doesn't read stdout, Pi blocks
   when the OS pipe buffer fills (~64KB). Reading per-step is the natural way
   to do this.
2. **Queue claim semantics** — claiming an event from the SQLite queue should
   only happen when the agent is ready. Claiming N events upfront risks losing
   work if the agent crashes mid-batch.
3. **Response attribution** — the `agent_start`/`agent_end` envelope on stdout
   gives clean boundaries between which events belong to which request.

## Source

Based on reading `node_modules/@mariozechner/pi-coding-agent/dist/modes/rpc/rpc-mode.js`
and `node_modules/@mariozechner/pi-coding-agent/dist/modes/rpc/jsonl.js`.
