# Busytown-Pi: Busytown Event Queue as a Pi Extension

## Context

Busytown is a multi-agent coordination framework where independent AI agents communicate exclusively through a shared SQLite event queue. We're re-implementing it as a **Pi extension** so that agents run as `pi` subprocesses instead of `claude --print`, and the event queue integrates naturally into Pi's extension ecosystem.

The core value being ported: **decoupled event-driven agents** — each agent only knows what events to listen for and what events to emit. No agent imports or references another.

## Architecture

A single Pi extension that:
1. Manages a SQLite event queue (ported from Busytown)
2. Discovers agents from `.pi/agents/*.md` that have `listen` fields
3. Runs background worker loops that poll the queue and spawn `pi` subprocesses
4. Registers tools so the host Pi session can push events (e.g., trigger `plan.request`)
5. Bundles a thin CLI so spawned subprocesses can push/claim events via bash

```
Host Pi session
  └─ busytown extension (manages event queue + workers)
       ├─ Worker: plan agent  →  spawns `pi --mode json -p --no-session`
       ├─ Worker: code agent  →  spawns `pi --mode json -p --no-session`
       └─ Worker: review agent →  spawns `pi --mode json -p --no-session`
                                      │
                               Each subprocess calls CLI to push/claim events
                               via shared SQLite DB (WAL mode)
```

## Agent `.md` Format

Merges Pi conventions with Busytown's `listen` pattern:

```yaml
---
name: plan
description: Explores the codebase and writes implementation plans
type: pi              # "pi" (default) or "shell"
listen:
  - plan.request
  - review.created
emits:
  - plan.created
  - plan.complete
ignore_self: true     # default: true
tools: read, grep, glob, write, bash
model: claude-sonnet-4-5
---

[System prompt body]
```

Only agents with a `listen` field are enrolled as Busytown workers. Others are left for Pi's standard subagent system.

## File Structure

```
busytown-pi/
  package.json
  tsconfig.json
  src/
    index.ts              # Pi extension entry point
    event-queue.ts        # SQLite event queue (port from Busytown)
    event.ts              # Event types + glob matching
    worker.ts             # Worker system (poll loop, spawn/kill/stop)
    agent.ts              # Agent .md loading with extended frontmatter
    agent-watcher.ts      # Hot-reload agents on .md file changes
    pi-process.ts         # Spawn `pi` subprocesses (replaces claude runner)
    template.ts           # Mustache templates for shell agents
    shell.ts              # Shell escape utility
    slug.ts               # Filename → agent ID
    cli.ts                # Thin CLI for subprocess event push/claim
    utils.ts              # sleep, nextTick helpers
```

## Key Design Decisions

### Event pushing: two mechanisms

1. **Host Pi session** → registered `busytown-push` tool (triggers workflows like `plan.request`)
2. **Spawned subprocesses** → CLI command via bash (agents push events like `plan.created`)

The CLI is bundled with the extension. The system prompt injected into each subprocess tells it how to call the CLI.

### Worker lifecycle

- **Start**: Extension's default export calls `pi.on("session_start", ...)` → opens DB, loads agents, creates worker system, spawns workers
- **Stop**: `pi.on("session_shutdown", ...)` → pushes lifecycle event, stops workers, closes DB
- Workers run as background async loops (polling with `setTimeout`), same as original Busytown

### SQLite concurrent access

Multiple processes (host Pi + spawned agent subprocesses) read/write the same SQLite file. Safe because:
- WAL mode enabled
- 5s busy timeout
- All writes are small single INSERTs
- This is exactly how original Busytown works

### Subprocess spawning

Original: `claude --print --system-prompt <prompt> --output-format stream-json`
New: `pi --mode json -p --no-session [--model <model>] [--tools <tools>] [--append-system-prompt <file>]`

Event JSON is passed as the task prompt. The `--append-system-prompt` flag injects the agent's `.md` body plus event queue CLI instructions.

## Dependencies

- `better-sqlite3` — Mature, synchronous SQLite for Node.js (safer than `node:sqlite` which is still experimental)
- `zod` — Schema validation (same as original Busytown)
- `gray-matter` — YAML frontmatter parsing (replaces Deno's `@std/front-matter`)
- `chokidar` — FS watching for agent hot-reload (replaces Deno's `watchFs`)
- `@sinclair/typebox` — Pi tool parameter schemas (matches Pi's convention)

## Implementation Order

### Phase 1: Core infrastructure (pure Node.js, no Pi dependency)

1. `src/event.ts` — Event types, `eventMatches()` glob logic
2. `src/event-queue.ts` — SQLite schema, push/poll/claim/cursor operations
3. `src/worker.ts` — Worker system with poll loop, spawn/kill/stop
4. `src/utils.ts` — sleep, abortableSleep, nextTick
5. `src/shell.ts` + `src/slug.ts` + `src/template.ts` — Small utilities

### Phase 2: Agent loading and execution

6. `src/agent.ts` — Frontmatter schema (extended with `listen`, `emits`, `ignore_self`), `.md` file loading
7. `src/pi-process.ts` — Spawn `pi` subprocesses, pipe stdout/stderr to event queue, build system prompts
8. `src/cli.ts` — Minimal CLI: `push`, `claim`, `check-claim` subcommands

### Phase 3: Pi extension integration

9. `src/index.ts` — Extension entry point:
   - Register `busytown-push` tool (push events from host session)
   - Register `busytown-events` tool (list recent events)
   - Register `busytown-claim` tool (claim events)
   - On `session_start`: open DB, load agents, start workers
   - On `session_shutdown`: stop workers, close DB
10. `src/agent-watcher.ts` — Watch `.pi/agents/` for changes, hot-reload workers

### Phase 4: Example agents

11. Port `agents/plan.md`, `agents/code.md`, `agents/review.md` to new format

## What's NOT ported

- **MCP permission server** — Pi handles permissions through its own extension system
- **React/Ink TUI dashboard** — Pi has its own TUI
- **Daemon management** (start/stop/restart/PID files) — Extension lifecycle replaces this
- **Generic FS watcher** (`file.create`/`file.modify`) — Nice-to-have, add later

## Verification

1. Install extension: symlink or copy to `.pi/extensions/busytown/`
2. Start Pi in a project with `.pi/agents/` containing plan/code/review agents
3. Use the `busytown-push` tool to push a `plan.request` event
4. Verify plan agent spawns as Pi subprocess, processes event, emits `plan.created`
5. Verify code agent picks up `plan.created`, claims it, emits `code.review`
6. Verify review agent picks up `code.review`, emits `review.created`
7. Check event queue state via `busytown-events` tool
