# Claude Code Agents

Claude Code lets you define custom subagents as markdown files. Each agent gets
its own context window, can be restricted to specific tools, and can optionally
maintain persistent memory across sessions.

## Defining an agent

An agent is a markdown file with YAML frontmatter. The markdown body is the
agent's system prompt.

```markdown
---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
---

You are a code reviewer. Analyze code and provide specific,
actionable feedback on quality, security, and best practices.
```

## Where to put agent files

Agents are stored as `.md` files in an `agents/` directory:

| Location            | Scope                             |
| ------------------- | --------------------------------- |
| `.claude/agents/`   | Current project only              |
| `~/.claude/agents/` | All projects for the current user |

Each agent is its own file:

```
.claude/agents/
  code-reviewer.md
  debugger.md
  test-runner.md
```

You can also create agents interactively using the `/agents` slash command.

## Frontmatter fields

Only `name` and `description` are required. All other fields are optional.

| Field             | Purpose                                                |
| ----------------- | ------------------------------------------------------ |
| `name`            | Unique identifier (lowercase letters, hyphens)         |
| `description`     | Tells Claude when to delegate to this agent            |
| `tools`           | Allowed tools (inherits all if omitted)                |
| `disallowedTools` | Tools to deny                                          |
| `model`           | `sonnet`, `opus`, `haiku`, full model ID, or `inherit` |
| `maxTurns`        | Maximum agentic turns before stopping                  |
| `permissionMode`  | `default`, `acceptEdits`, `auto`, `plan`, etc.         |
| `memory`          | `user`, `project`, or `local` (see below)              |
| `background`      | `true` to always run as a background task              |
| `effort`          | `fast`, `balanced`, or `thorough`                      |
| `skills`          | Skills to preload into the agent's context             |
| `mcpServers`      | MCP servers available to the agent                     |
| `hooks`           | Lifecycle hooks scoped to the agent                    |

## Agent memory

Agents can maintain persistent memory across sessions. This lets them learn
patterns and accumulate knowledge over time.

Enable it by setting the `memory` field in frontmatter:

```markdown
---
name: debugger
description: Diagnoses errors and test failures
tools: Read, Grep, Bash, Glob
memory: project
---

You are an expert debugger. Analyze error messages, identify root
causes, and provide fixes. Learn from patterns in this project.
```

### Memory scopes

| Scope     | Storage path                               | Use case                                         |
| --------- | ------------------------------------------ | ------------------------------------------------ |
| `user`    | `~/.claude/agent-memory/<agent-name>/`     | Knowledge applicable across all projects         |
| `project` | `.claude/agent-memory/<agent-name>/`       | Project-specific, can be checked into VCS        |
| `local`   | `.claude/agent-memory-local/<agent-name>/` | Project-specific, should not be checked into VCS |

### Memory structure

Each agent's memory directory follows the same structure as Claude Code's own
memory system:

```
.claude/agent-memory/debugger/
  MEMORY.md
  <topic>.md
  <topic>.md
```

`MEMORY.md` is an index file. The first 200 lines (or 25KB, whichever is
smaller) are automatically loaded into the agent's context at startup. Detailed
notes go into separate topic files that are loaded on demand.

The agent curates its own memory, writing topic files and maintaining the index
as it learns.

## Key behaviors

- **Isolated context**: each agent runs in its own context window. Tool calls
  and results stay within the agent; only the final result returns to the
  parent.
- **Cost control**: route simple tasks to faster/cheaper models like `haiku`.
- **Tool restrictions**: limit what each agent can do by specifying `tools` or
  `disallowedTools`.
- **Parallel execution**: multiple agents can run concurrently.
- **One level deep**: agents cannot spawn their own subagents.
