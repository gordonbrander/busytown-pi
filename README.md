# busytown-pi

_A town full of busy little guys who do things — now as a Pi extension._

**busytown** is a multi-agent coordination framework built around a shared
SQLite event queue.

It can be used standalone, or as a [Pi](https://github.com/nichochar/pi-coding-agent)
extension. Each agent is a separate subprocess. Agents listen for events,
react to them, and push new events, forming an asynchronous pipeline where no
agent needs to know about any other agent — only about the events.

## How it works

Everything is stored in a single SQLite database (`.busytown/events.db`).
Events are simple JSON objects:

```json
{
  "id": 1,
  "type": "plan.request",
  "timestamp": 1709568000,
  "worker_id": "host",
  "payload": { "prd_path": "docs/feature.md" }
}
```

The worker system polls the queue and dispatches events to matching agents.
Agents run in parallel, but each agent processes events serially, one at a time,
in order. Each agent:

- **Listens** for specific event types (exact match, prefix glob like `task.*`,
  or wildcard `*`)
- **Reacts** by reading files, writing code, producing artifacts
- **Pushes** new events to notify other agents of what it did
- **Claims** events when needed, so only one agent acts on a given event

## Architecture

## Architecture

```
┌──────────┐    push     ┌─────────────────┐    dispatch    ┌───────────┐
│  Pi /    │───────────▸ │  SQLite Event   │ ─────────────▸ │  Agent    │
│  CLI     │             │  Queue          │ ◂───────────── └───────────┘
└──────────┘             │                 │    push new
                         │  events table   │    events
                         │  worker_cursors │
                         │  claims         │
                         └─────────────────┘
                                 ▲ │
                                 │ ▼
                            ┌───────────┐
                            │  Agent    │
                            └───────────┘
```

## Getting started

### Install

```bash
cd your-project
npm install busytown-pi
```

Or globally:

```bash
cd your-project
npm install -g busytown-pi
```

### Enable the extension

Add busytown-pi to your project's `.pi/settings.json`:

```json
{
  "packages": ["busytown-pi"]
}
```

Or enable it for a single session:

```bash
pi -e busytown-pi
```

Once loaded, the extension registers three tools (`busytown-push`,
`busytown-events`, `busytown-claim`) and three slash commands, and starts
watching for agent definitions.

### Directory structure

```
your-project/
├── .pi/
│   └── agents/          # Agent definitions (markdown files)
└── .busytown/
    └── events.db        # SQLite event queue (auto-created)
```

## Writing agents

An agent is a markdown file in `.pi/agents/`. The filename becomes the agent's
ID (e.g., `planner.md` → agent ID `planner`).

### Minimal example

```markdown
---
listen:
  - "task.created"
tools:
  - read
  - write
---

When you receive a `task.created` event, read the file at
`payload.file_path` and summarize it to `summaries/<name>.md`.

Then push a `task.summarized` event.
```

### Frontmatter fields

| Field         | Type                | Default  | Description                                          |
| ------------- | ------------------- | -------- | ---------------------------------------------------- |
| `name`        | string              | filename | Override the agent ID                                |
| `type`        | `"pi"` \| `"shell"` | `"pi"`   | Agent type                                           |
| `description` | string              | `""`     | What this agent does                                 |
| `listen`      | string[]            | `[]`     | Event patterns to listen for                         |
| `ignore_self` | boolean             | `true`   | Ignore events this agent emitted                     |
| `emits`       | string[]            | `[]`     | Event types this agent can emit (documentation only) |
| `tools`       | string \| string[]  | `[]`     | Pi tools available to the agent                      |
| `model`       | string              | —        | Model override (e.g., `"opus"`, `"sonnet"`)          |

### Agent types

**Pi agents** (`type: "pi"`, the default) run as `pi --mode json` subprocesses.
The event JSON is piped to stdin, and the agent's markdown body becomes its
system prompt. Pi agents can use tools and the CLI to push events and claim work.

**Shell agents** (`type: "shell"`) run the body as a shell script via `sh -c`.
The body is rendered as a Mustache-style template with access to the triggering
event:

- `{{event.type}}` — shell-escaped value (safe by default)
- `{{{event.payload.path}}}` — raw value (no escaping)
- Dot paths walk nested objects. Missing keys resolve to empty string.

### Event patterns

The `listen` field supports:

- `"task.created"` — exact match
- `"task.*"` — prefix match (matches `task.created`, `task.updated`, etc.)
- `"*"` — match all events

## Tools & commands

Once the extension is loaded, you get three tools and three slash commands.

### Tools (for LLM use)

| Tool              | Description                         |
| ----------------- | ----------------------------------- |
| `busytown-push`   | Push an event to the queue          |
| `busytown-events` | List recent events (with filtering) |
| `busytown-claim`  | Claim an event for exclusive access |

### Slash commands (for human use)

| Command            | Usage                                                           |
| ------------------ | --------------------------------------------------------------- |
| `/busytown-push`   | `/busytown-push plan.request '{"prd_path": "docs/feature.md"}'` |
| `/busytown-events` | `/busytown-events --tail 10 --type plan.*`                      |
| `/busytown-claim`  | `/busytown-claim 42 my-worker`                                  |

## Standalone CLI

The package also includes a standalone CLI for running agents outside of Pi, or
for agents to interact with the event queue from subprocesses:

```bash
# Start the worker system (long-running)
busytown start

# Push an event
busytown push --worker my-script --type plan.request --payload '{"key":"value"}'

# List events
busytown events --tail 10 --type plan.*

# List loaded agents
busytown agents

# Claim an event
busytown claim --worker my-agent --event 42

# Check who claimed an event
busytown check-claim --event 42
```

## Example: Plan → Code → Review

A classic multi-agent workflow where one agent plans, another implements, and a
third reviews.

### `.pi/agents/planner.md`

```markdown
---
description: Explores the codebase and writes implementation plans
model: opus
listen:
  - "plan.request"
  - "review.created"
emits:
  - "plan.created"
tools:
  - read
  - grep
  - glob
  - write
---

When you receive a `plan.request` event, read the PRD at
`payload.prd_path`, explore the codebase, and write a plan to
`plans/<name>.md`. Push a `plan.created` event.

When you receive a `review.created` event with verdict `"revise"`,
update the plan and push `plan.created` again.
```

### `.pi/agents/coder.md`

```markdown
---
description: Implements code changes by following plans
listen:
  - "plan.created"
emits:
  - "code.review"
tools:
  - read
  - grep
  - glob
  - edit
  - write
---

When you receive a `plan.created` event:

1. **Claim the event first.** If the claim fails, stop.
2. Read the plan at `payload.plan_path`.
3. Implement each step.
4. Push a `code.review` event.
```

### `.pi/agents/reviewer.md`

```markdown
---
description: Reviews code changes for correctness and style
model: opus
listen:
  - "code.review"
emits:
  - "review.created"
tools:
  - read
  - grep
  - glob
  - write
---

When you receive a `code.review` event:

1. Read the plan and changed files.
2. Review for correctness, types, and style.
3. Write a review to `reviews/<name>.md`.
4. Push `review.created` with verdict `"approve"` or `"revise"`.
```

### Kick it off

From your Pi session:

```
Use busytown-push with type "plan.request"
and payload '{"prd_path": "docs/add-auth.md"}'
```

This triggers the cycle: planner → coder → reviewer → planner (if revisions
needed) → repeat until approved.

## Hot reload

Agent files in `.pi/agents/` are watched for changes:

- **New file** → agent spawns immediately
- **Modified file** → worker restarts with new configuration
- **Deleted file** → worker stops

No restart required.

## System events

Busytown emits system events automatically with the `sys.` prefix:

| Event                    | When                          |
| ------------------------ | ----------------------------- |
| `sys.lifecycle.start`    | Extension initialized         |
| `sys.lifecycle.finish`   | Extension shutting down       |
| `sys.agent.create`       | New agent file detected       |
| `sys.agent.reload`       | Agent file modified           |
| `sys.agent.remove`       | Agent file deleted            |
| `sys.worker.<id>.start`  | Worker began processing event |
| `sys.worker.<id>.finish` | Worker completed              |
| `sys.worker.<id>.error`  | Worker encountered error      |

You can listen for system events like any other:

```yaml
listen:
  - "sys.agent.*"
```

## Key concepts

- **Cursor-based delivery** — Each worker maintains its own cursor. The cursor
  advances before processing, giving at-most-once delivery.
- **First-claim-wins** — When multiple agents listen for the same event type,
  `claimEvent()` ensures only one processes a given event.
- **Namespace wildcards** — Event types use dot-separated namespaces. Listen for
  `file.*` to catch `file.create`, `file.modify`, etc.
- **Agents are just markdown** — Agent definitions are markdown files with YAML
  frontmatter. Easy to version, review, and iterate on.
- **No agent coupling** — Agents don't know about each other. They only know
  about events. Add, remove, or swap agents without changing anything else.
- **Hot reload** — Edit an agent file and the worker restarts automatically.

## Development

```bash
# Run tests
npm test

# Lint
npm run lint

# Format
npm run format
```

## License

MIT
