# Busytown-Pi: What It Is and How It Works

**Busytown-Pi** is a multi-agent orchestration framework. Agents coordinate
through a shared SQLite event queue — they never import or reference each other,
only listen for and emit events. It's designed to run alongside (and inside) the
Pi coding agent.

## The Core Idea

A SQLite database is the sole integration point. Agents are independent
processes that:

1. **Listen** for events matching glob patterns (e.g. `plan.request`, `code.*`)
2. **Process** matching events by streaming back response events
3. **Emit** new events that other agents can pick up

Cursor-based delivery ensures at-most-once processing. A claim system lets
agents race for exclusive ownership of an event.

## The Daemon

A long-running background process (`busytown start`) that:

- Opens the SQLite event queue at `.busytown/events.db`
- Loads agent definitions from `.pi/agents/*.md` files
- Runs an async poll loop per agent, pulling matching events and feeding them to
  the agent's `stream()` method
- Watches the filesystem and pushes `file.create`/`file.modify`/`file.delete`
  events
- Manages its lifecycle via a pidfile
- Shuts down gracefully on SIGINT/SIGTERM

## The CLI

Thin commands for interacting with the queue from outside:

```
busytown start / stop / status / reload
busytown push --agent <id> --type <type> [--payload <json>]
busytown events [--tail N] [--type <filter>]
busytown claim --agent <id> --event <id>
busytown check-claim --event <id>
```

## The Pi Extension

When loaded into a Pi session (`index.ts`), it:

- **Auto-starts the daemon** as a detached child process if not already running
- **Registers slash commands** (`/busytown-push`, `/busytown-events`,
  `/busytown-claim`, etc.) and equivalent tools
- **Renders a dashboard widget** in Pi's status bar showing daemon health and
  per-agent status (idle, running, error)
- **Supports `--agent <name>` mode**: loads an agent definition and injects its
  system prompt, memory blocks, tools, and hooks into the current Pi session —
  turning the Pi session itself into a busytown agent

## Agent Definitions

Agents are `.md` files in `.pi/agents/` with YAML frontmatter:

```markdown
---
type: "pi"
listen: ["plan.request", "code.*"]
tools: ["read", "bash"]
model: "claude-sonnet"
memory_blocks:
  context:
    description: "Persistent scratchpad"
    char_limit: 2000
hooks:
  before_agent_start: "cat context.json"
---

You are an expert planner. When you receive a plan.request event...
```

The markdown body becomes the agent's system prompt.

## Agent Types

- **Pi RPC agents** (`type: "pi"`): Spawn a `pi --mode rpc` subprocess. The
  agent extension (`agent-extension.ts`) is injected automatically, providing
  busytown tools (push/events/claim), memory blocks, and hooks. Communication is
  JSONL over stdin/stdout. These are full coding agents that can use tools,
  think, and produce multi-turn responses.

- **Shell agents** (`type: "shell"`): The markdown body is a Mustache template
  rendered with the triggering event as context, then executed via `sh -c`. Each
  stdout line becomes a response event. Simple, stateless, good for glue tasks.

- **Claude agents** (`type: "claude"`): Planned but not yet implemented — would
  spawn the `claude` CLI.

## Event Flow Example

```
User pushes "plan.request" via /busytown-push
  → Daemon's poll loop picks it up for the "planner" agent (listens: ["plan.request"])
  → planner agent (Pi RPC) processes it, emits "plan.created"
  → "coder" agent (listens: ["plan.created"]) picks up the plan
  → coder processes it, emits "code.created"
  → "reviewer" agent picks up "code.created"
  → ...and so on
```

The system is a pipeline of autonomous agents, each reacting to the output of
others, coordinated entirely through the event queue.
