# Busytown Pi — Guide

Busytown is a multi-agent coordination system that runs as a Pi extension. Agents
communicate through a shared SQLite event queue — each agent listens for events,
does work, and pushes new events for other agents to pick up.

## Setup

### Install

```bash
cd your-project
npm install busytown-pi
```

### Enable the extension

Add busytown-pi to your Pi configuration so it loads on session start. The
extension registers three tools (`busytown-push`, `busytown-events`,
`busytown-claim`) and starts watching for agent definitions.

### Directory structure

Busytown uses two directories in your project:

```
your-project/
├── .pi/
│   └── agents/          # Agent definitions (markdown files)
├── .busytown/
│   └── events.db        # SQLite event queue (auto-created)
```

## Writing agents

An agent is a markdown file in `.pi/agents/`. The filename becomes the agent's
ID (e.g., `planner.md` → agent ID `planner`).

Each file has YAML frontmatter for configuration and a markdown body for
instructions.

### Minimal example

```markdown
---
listen:
  - "task.created"
---

When you receive a `task.created` event, read the file at
`payload.file_path` and summarize it.
```

### Frontmatter fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | filename | Override the agent ID |
| `type` | `"pi"` \| `"shell"` | `"pi"` | Agent type |
| `description` | string | `""` | What this agent does |
| `listen` | string[] | `[]` | Event patterns to listen for |
| `ignore_self` | boolean | `true` | Ignore events this agent emitted |
| `emits` | string[] | `[]` | Event types this agent can emit (documentation only) |
| `tools` | string \| string[] | `[]` | Pi tools available to the agent |
| `model` | string | — | Model override (e.g., `"opus"`, `"sonnet"`) |

### Agent types

**Pi agents** (`type: "pi"`, the default) run as Pi subprocesses. The event JSON
is piped to stdin, and the agent's body is appended to its system prompt. Pi
agents can use tools and the CLI to push events and claim work.

**Shell agents** (`type: "shell"`) run the body as a shell script. The body is
rendered as a template with access to the triggering event (see Templates below).

### Event patterns

The `listen` field accepts these patterns:

- `"task.created"` — exact match
- `"task.*"` — prefix match (matches `task.created`, `task.updated`, etc.)
- `"*"` — match all events

### Templates (shell agents)

Shell agent bodies support Mustache-style template variables:

- `{{event.type}}` — shell-escaped value
- `{{{event.type}}}` — raw value (no escaping)
- `{{event.payload.file_path}}` — dot-path access into nested fields

Example shell agent:

```markdown
---
type: shell
listen:
  - "file.changed"
---

echo "File changed: {{event.payload.path}}"
cat {{{event.payload.path}}} | wc -l
```

## Events

Events are the core unit of communication. Each event has:

```typescript
{
  id: number          // Auto-incrementing
  timestamp: number   // Unix epoch (seconds)
  type: string        // e.g., "plan.created"
  worker_id: string   // Who emitted it
  payload: unknown    // Arbitrary JSON data
}
```

### Pushing events

From a Pi agent, use the CLI:

```bash
busytown push --db <db-path> --worker <agent-id> --type plan.created \
  --payload '{"plan_path": "plans/my-plan.md"}'
```

The system prompt injected into each Pi agent includes the exact command with the
correct `--db` and `--worker` flags, so agents don't need to figure those out.

From the host Pi session, use the `busytown-push` tool:

```
Use the busytown-push tool with type "plan.request"
and payload '{"prd_path": "docs/feature.md"}'
```

### Listing events

Use the `busytown-events` tool from the host session:

```
Use busytown-events with tail 10
```

Or filter by type:

```
Use busytown-events with type "plan.created"
```

### Claiming events

When multiple agents listen for the same event type, use claims to ensure only
one agent processes each event. This gives you at-most-once delivery.

From a Pi agent:

```bash
busytown claim --db <db-path> --worker <agent-id> --event <event-id>
```

This returns JSON like `{"claimed": true, "claimant": {"worker_id": "coder", "claimed_at": 1709568000}}`. If `claimed` is `false`, another agent already
claimed it — skip the event.

From the host session, use the `busytown-claim` tool.

## System events

Busytown emits system events automatically. These all have the `sys.` prefix:

| Event | When |
|-------|------|
| `sys.lifecycle.start` | Extension initialized |
| `sys.lifecycle.finish` | Extension shutting down |
| `sys.agent.create` | New agent file detected |
| `sys.agent.reload` | Agent file modified |
| `sys.agent.remove` | Agent file deleted |
| `sys.agent.error` | Agent file failed to parse |
| `sys.cursor.create` | Worker's first poll |
| `sys.claim.create` | Event successfully claimed |
| `sys.worker.<id>.start` | Worker began processing event |
| `sys.worker.<id>.finish` | Worker completed |
| `sys.worker.<id>.error` | Worker encountered error |
| `sys.worker.<id>.stdout` | Line of worker stdout |
| `sys.worker.<id>.stderr` | Line of worker stderr |

You can listen for system events just like any other:

```yaml
listen:
  - "sys.agent.*"
```

## Hot reload

Agent files are watched for changes. When you edit, create, or delete an agent
`.md` file:

- **New file**: Agent spawns immediately
- **Modified file**: Worker restarts with new configuration
- **Deleted file**: Worker stops

No restart required.

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
  - "plan.complete"
tools:
  - Read
  - Grep
  - Glob
  - Write
---

When you receive a `plan.request` event, read the file at
`payload.prd_path`, explore the codebase, and write an implementation
plan to `plans/<name>.md`.

Push a `plan.created` event with `{"plan_path": "plans/<name>.md"}`.

When you receive a `review.created` event with `payload.verdict` of
`"revise"`, update the plan and push `plan.created` again. If the
verdict is `"approve"`, push `plan.complete`.
```

### `.pi/agents/coder.md`

```markdown
---
description: Implements code changes by following plans
model: sonnet
listen:
  - "plan.created"
emits:
  - "code.review"
tools:
  - Read
  - Grep
  - Glob
  - Edit
  - Write
---

When you receive a `plan.created` event:

1. **Claim the event first.** If the claim fails, stop.
2. Read the plan at `payload.plan_path`.
3. Implement each step.
4. Push a `code.review` event with
   `{"plan_path": "...", "files_changed": [...], "summary": "..."}`.
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
  - Read
  - Grep
  - Glob
  - Write
---

When you receive a `code.review` event:

1. Read the plan and changed files.
2. Review for correctness, types, and style.
3. Write review to `reviews/<name>.md`.
4. Push `review.created` with
   `{"plan_path": "...", "verdict": "approve|revise", "summary": "..."}`.
```

### Kicking it off

From your Pi session:

```
Use busytown-push with type "plan.request"
and payload '{"prd_path": "docs/add-auth.md"}'
```

This triggers the cycle: planner writes a plan → coder implements it → reviewer
checks it → planner revises if needed → repeat until approved.

## Example: Shell agent for notifications

```markdown
---
type: shell
listen:
  - "plan.complete"
---

echo "Plan complete: {{{event.payload.plan_path}}}" >> .busytown/completed.log
```

## Tips

- **Claim before working.** If multiple agents listen for the same event, use
  claims to avoid duplicate work.
- **Keep payloads useful.** Include file paths, summaries, and IDs that
  downstream agents need.
- **Use `ignore_self: true`** (the default) to prevent feedback loops where an
  agent triggers itself.
- **Use `emits` for documentation.** It doesn't affect behavior but makes the
  event flow easy to understand at a glance.
- **Hierarchical event types.** Use dot-separated names like `plan.request`,
  `plan.created`. This lets agents use prefix patterns (`plan.*`) to listen
  broadly.
- **Start simple.** A single agent listening for one event type is a good
  starting point. Add more agents as workflows emerge.
