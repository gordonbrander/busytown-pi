## Goals

Goals for agent abstraction:

- Represents long-lived process
  - Instantiates a type that lets you interact with the agent process
  - daemon will manage agent processes
- Abstracts over implementations. The core implementation is a Pi RPC agent. However, we want to wrap other kinds of agent implementation in the same interface:
  - Pi RPC agent
  - `claude --json` mode shell calls
  - shell commands
- High level concepts
  - Send events, receive responses
  - Responses logically organized into:
    - Steps (messages, tool calls, reasoning steps, etc)
    - Turns: `user prompt -> agent response -> user prompt -> ...`
      - Each of these is a turn. A turn is made of many steps.
- Ability to stream messages
- Ability to ergonomically trigger code on end of step
- Ability to ergonomically trigger code on end of turn
- Backpressure (e.g. via web streams)
  - Apply backpressure on sent event until agent completes turn (e.g. one event at a time)
    - Question: can/should we insert steering messages while the agent is in a turn?
- Cancellation (via AbortController)
  - Cancel streaming and immediately finish message/turn

## Implementation notes

- Abstraction should be as thin as is sensible
- If we need streams, prefer web streams to node streams
