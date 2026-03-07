Busytown Today

Busytown is a multi-agent coordination framework built on a shared SQLite event queue. Independent Claude Code agents (defined as Markdown files with YAML frontmatter).

communicate exclusively through events — no agent knows about any other. The pipeline is typically: plan.request → Plan Agent → plan.created → Code Agent → code.review → Review Agent → review.created (with revision loops). It runs on Deno, spawns agents as claude --print subprocesses, and has a React/Ink TUI dashboard.

Pi Platform

Pi is a minimal, extensible terminal-based coding agent harness. Key points:

- 4 built-in tools (read, write, edit, bash) — everything else comes from extensions
- Agents defined as Markdown with YAML frontmatter (name, description, tools, model) — very similar to Busytown
- Subagents are an extension (not core), each running as a separate pi child process with isolated context
- 3 subagent modes: single, parallel (up to 4 concurrent), chain (sequential with {previous} output passing)
- Extensions API: register tools, commands, event hooks, UI; full lifecycle events
- 4 operational modes: interactive TUI, print/JSON, RPC (stdin/stdout JSON protocol), SDK (programmatic)
- SDK: createAgentSession() gives full programmatic control — multiple sessions, steering, follow-up, event subscriptions

Mapping Busytown → Pi

┌───────────────────────────┬───────────────────────────────────────┬──────────────────────────────────────────────────────────────┐
│ Busytown Concept │ Pi Equivalent │ Notes │
├───────────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────────────────────────┤
│ Agent .md files │ .pi/agents/\*.md │ Nearly identical format (Markdown + YAML frontmatter) │
├───────────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────────────────────────┤
│ claude --print subprocess │ pi --mode json subprocess │ Same pattern — isolated process per agent │
├───────────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────────────────────────┤
│ Event queue (SQLite) │ No equivalent │ Pi subagents communicate via tool results, not event streams │
├───────────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────────────────────────┤
│ Event-driven decoupling │ Chain/parallel modes │ Pi chains pass {previous} output; less decoupled than events │
├───────────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────────────────────────┤
│ Claims (first-wins dedup) │ No equivalent │ Pi doesn't have competing consumers │
├───────────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────────────────────────┤
│ Worker cursors │ No equivalent │ No persistent cursor tracking │
├───────────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────────────────────────┤
│ FS watcher │ No equivalent (could be an extension) │ │
├───────────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────────────────────────┤
│ MCP permission server │ Extension-based tool permissions │ Different mechanism, same goal │
├───────────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────────────────────────┤
│ React/Ink TUI dashboard │ Pi TUI (built-in) │ Pi has its own TUI │
└───────────────────────────┴───────────────────────────────────────┴──────────────────────────────────────────────────────────────┘

Key Architectural Tension

Busytown's core innovation is the decoupled event queue — agents are actors that only communicate through events, enabling arbitrary topologies and dynamic agent addition.
Pi's subagent model is more hierarchical — a parent agent delegates to children via tool calls, with results flowing back up.

Two paths forward:

1. Busytown agents as Pi subagents — Use Pi's chain/parallel modes. Simpler but loses the event-driven decoupling. The plan→code→review loop maps well to chain mode.
2. Busytown event queue as a Pi extension — Build an extension that registers an event queue tool, enabling the decoupled actor pattern within Pi. Preserves Busytown's
   architecture while leveraging Pi's infrastructure (TUI, multi-provider LLM, auth, sessions).

Option 2 is more faithful to Busytown's design but more work. Option 1 gets you running fast but fundamentally changes the coordination model.

Want me to dig deeper into either path, or should I start planning the implementation?
