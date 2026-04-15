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

- Opens the SQLite event queue at `.pi/busytown/events.db`
- Loads agent definitions from `.pi/agents/*.md` files
- **Spawns each agent as a standalone child process** via a generic process
  supervisor (`ProcessSystem`), rather than running agents in-process
- Watches the filesystem and pushes `file.create`/`file.modify`/`file.delete`
  events
- Subscribes to `sys.reload` events via the SDK; on reload it disposes the
  current `ProcessSystem` and respawns all agents from disk
- Manages its lifecycle via a pidfile
- Shuts down gracefully on SIGINT/SIGTERM, SIGTERMing all child processes with
  a 5-second SIGKILL fallback

## Process Supervision

Each agent runs as its own Node child process managed by `ProcessSystem`:

- **Crash/restart**: crashed processes restart with exponential backoff
  (`2^n × 1000ms`), capped at 3 restarts
- **Stability window**: the restart counter resets after a process has been up
  for 30 seconds
- **Orphan protection**: each subprocess checks on every poll tick whether its
  parent PID is still the daemon. If the daemon dies unexpectedly, children exit
  cleanly instead of zombie-polling.

## The SDK (`busytown/sdk`)

A minimal event-queue client for use from agent subprocesses or any external
program:

```ts
import { clientOf } from "busytown/sdk";

const client = clientOf({ id: "my-agent", dbPath, parentPid });

// Publish an event
await client.publish({ type: "code.created", payload: { ... } });

// Claim an event for exclusive processing
await client.claim(eventId);

// Subscribe to matching events (async iterable)
for await (const event of client.subscribe({ listen: ["plan.*"] })) {
  // handle event
}
```

`clientOf` opens its own SQLite handle and manages a cursor for the given `id`.

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
type: "pi-rpc"
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

The markdown body becomes the agent's system prompt. At startup, the daemon
spawns a child process for each `.md` file; the child process parses the
definition, connects to the event queue via `busytown/sdk`, and dispatches to
the appropriate handler.

## Agent Types

- **Pi agents** (`type: "pi"`): The `pi` agent wakes up with a totally fresh session for each event. The agent extension (`pi-agent-extension.ts`) is injected automatically, providing busytown tools (push/events/claim), memory blocks, and hooks.

- **Pi RPC agents** (`type: "pi-rpc"`): Similar to Pi agent, but spawned via a long-lived `pi --mode rpc` subprocess. Think of it as a "Claw" that lives as long as the Busytown daemon is running. These are full coding agents that can use tools, think, and produce multi-turn responses.

- **Shell agents** (`type: "shell"`): The markdown body is a Mustache template
  rendered with the triggering event as context, then executed via `sh -c`. Each
  stdout line becomes a response event. Simple, stateless, good for glue tasks.

- **Claude agents** (`type: "claude"`): Declared but not yet implemented.

## Event Flow Example

```
User pushes "plan.request" via /busytown-push
  → Daemon's ProcessSystem has spawned "planner" as a child process
  → planner subprocess polls the queue (via SDK), picks up the event
  → planner (Pi RPC) processes it, emits "plan.created"
  → "coder" subprocess (listens: ["plan.created"]) picks up the plan
  → coder processes it, emits "code.created"
  → "reviewer" subprocess picks up "code.created"
  → ...and so on
```

The system is a pipeline of autonomous agents, each reacting to the output of
others, coordinated entirely through the event queue.
