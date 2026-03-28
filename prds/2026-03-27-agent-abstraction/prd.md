## Goals

Goals for agent abstraction:

- Can be used to manage a long-lived process
  - But occasionally used to abstract over many short-lived processes.
- Abstracts over multiple implementations. The core implementation is a Pi RPC agent. However, we want to wrap other kinds of agent implementation in the same interface:
  - Pi RPC agent (long-lived)
  - `claude --json` mode shell calls (multiple short-lived)
  - shell commands (multiple short-lived)
- High level concept
  - Send events, receive stream of responses
  - Lifecycle conceptually organized into:
    - Agent (lifetime of the process handle)
      - Agent run / step (one send → all responses until agent quiesces)
        - Turns (text delta, tool call, reasoning delta, etc)
- Design goals
  - Ability to stream messages via async iteration
  - Ability to ergonomically trigger code on end of step (natural — the `for-await-of` loop ends)
  - Ability to ergonomically trigger code on end of turn (match on `turn_end` event)
  - Backpressure via async iteration
    - The caller's `for-await-of` loop must finish before the next `send()` can begin — one step at a time
  - Cancellation
    - Per-run: abort the current step without tearing down the agent process
    - Full teardown: `kill()` shuts down the process entirely

## Implementation notes

- Abstraction should be as thin as is sensible. We should closely adhere to Pi names for concepts.
- `send()` returns an `AsyncIterable<ResponseEvent>`, implemented as an async generator
- Internally, Pi RPC holds a single `ReadableStreamDefaultReader` on stdout for the process lifetime. Each `send()` call writes to stdin, then yields events from the shared reader until `agent_end`.
- A simple `busy` boolean flag guards against concurrent `send()` calls — this is the only concurrency state needed.
- When we need streams, prefer web streams to node streams
