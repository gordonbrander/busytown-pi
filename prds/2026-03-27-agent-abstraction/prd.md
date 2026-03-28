## Goals

Goals for agent abstraction:

- Can be used to manage a long-lived process
  - But occassionally used to abstract over many short-lived processes.
- Abstracts over multiple implementations. The core implementation is a Pi RPC agent. However, we want to wrap other kinds of agent implementation in the same interface:
  - Pi RPC agent (long-lived)
  - `claude --json` mode shell calls (multiple short-lived)
  - shell commands (multiple short-lived)
- High level concept
  - Send events, receive stream of responses
  - Lifecycle conceptually organized into:
    - Agent
      - Agent run (loops turns until agent quiesces)
        - Turns (text delta, tool call, reasoning delta, etc)
- Design goals
  - Ability to stream messages
  - Ability to ergonomically trigger code on end of step
  - Ability to ergonomically trigger code on end of turn
  - Backpressure (e.g. via web streams)
    - Apply backpressure on sent event until agent completes turn (e.g. one event at a time)
  - Cancellation (via AbortController)
    - Cancel streaming and immediately finish message/turn
  - Question: can/should we insert steering messages while the agent is in a turn?

## Implementation notes

- Abstraction should be as thin as is sensible. We should closely adhere to Pi names for concepts.
- When we need streams, prefer web streams to node streams
