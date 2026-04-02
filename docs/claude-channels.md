# How Channels Work in Claude Code

Claude Code is Anthropic's CLI-based coding assistant that runs locally in a user's terminal. Channels are a research preview feature (introduced in v2.1.80) that extends Claude Code's local session model by allowing external systems to push events and messages into a running session. This report covers the full architecture: what channels are, what problem they solve, how they work at a protocol level, and how memory and context are managed across long-running channel-enabled sessions.

## 1. The Problem Channels Solve

Claude Code sessions are inherently interactive and local. A user opens a terminal, starts a session, and types prompts. Claude has access to the local filesystem, shell, and project context. But nothing can reach _into_ that session from the outside world while the user is away from the terminal.

Before channels, the options for bridging external events into Claude were:

- **Claude Code on the web**: Spawns a fresh cloud sandbox cloned from GitHub. Good for delegating async work, but it's a separate environment with no access to the user's local files or in-progress session.
- **Claude in Slack**: Starts a web session from an `@Claude` mention. Good for team conversations, but again spins up a new session rather than reaching into an existing one.
- **Standard MCP servers**: Claude queries them on demand during a task, but nothing is pushed to the session. They are pull-only.
- **Remote Control**: Lets the user steer their local session from claude.ai or the Claude mobile app. This is remote access to the session, not event-driven.

Channels fill the gap by enabling **push-based event delivery** into an already-running local session. When a CI build fails, a monitoring alert fires, or someone sends a message on Telegram, the event arrives in the session where Claude already has the user's files open and remembers what was being worked on.

## 2. What Channels Are

A channel is an MCP (Model Context Protocol) server that declares a special capability (`claude/channel`) and emits notification events into a Claude Code session. Claude Code spawns the channel server as a subprocess, connected over stdio. When the channel has something to deliver, it pushes a notification, which arrives in the session as a `<channel>` tag that Claude can read and act on.

Channels can be:

- **One-way**: Forward alerts, webhooks, or monitoring events for Claude to act on. No response goes back through the channel.
- **Two-way**: Act as chat bridges. Claude reads the inbound event and can call a reply tool exposed by the channel to send messages back to the originating platform.

### 2.1 Supported Channels

The research preview includes two production channels and one demo:

- **Telegram**: A plugin that polls the Telegram Bot API for messages. Users create a bot via BotFather, configure the token, and pair their Telegram account via a code exchange.
- **Discord**: A plugin that connects to the Discord gateway. Users create a bot in the Discord Developer Portal, enable the Message Content Intent, invite it to a server, and pair via a code exchange.
- **Fakechat**: A localhost demo channel that runs a web UI at `http://localhost:8787`. No authentication or external service required. Useful for testing the channel model before connecting a real platform.

All three are distributed through the `claude-plugins-official` marketplace.

## 3. How Channels Work

### 3.1 Architecture

The architecture is entirely local. Claude Code runs in the user's terminal. Channel servers run as subprocesses spawned by Claude Code, communicating over stdio using the MCP protocol. For chat-platform channels (Telegram, Discord), the subprocess polls the platform's API. For webhook-style channels, the subprocess listens on a local HTTP port.

```
External System (Telegram API, CI webhook, etc.)
        │
        ▼
Local Channel Server (MCP subprocess, spawned by Claude Code)
        │ stdio (MCP protocol)
        ▼
Claude Code Session (local terminal)
        │
        ▼
Local filesystem, shell, project context
```

There is no cloud intermediary. The channel server and Claude Code session are both local processes on the user's machine.

### 3.2 Lifecycle

1. The user installs a channel plugin: `/plugin install telegram@claude-plugins-official`
2. The user configures credentials: `/telegram:configure <token>`
3. The user launches Claude Code with the channel enabled: `claude --channels plugin:telegram@claude-plugins-official`
4. Claude Code reads the MCP config, spawns the channel server as a subprocess, and detects the `claude/channel` capability.
5. The channel server begins listening for events (polling Telegram, listening on an HTTP port, etc.).
6. When an event arrives, the server emits a `notifications/claude/channel` notification over stdio.
7. Claude Code injects the event into the session as a `<channel>` tag.
8. Claude processes the event with full access to the local project context.
9. For two-way channels, Claude can call the channel's reply tool to send a response back to the originating platform.

### 3.3 The MCP Protocol Contract

A channel server must:

1. **Declare the capability**: Set `capabilities.experimental['claude/channel']` to `{}` in the MCP Server constructor. This is what tells Claude Code to register a notification listener.
2. **Provide instructions**: An `instructions` string in the constructor is added to Claude's system prompt. It tells Claude what events to expect, what the `<channel>` tag attributes mean, whether to reply, and how to route replies.
3. **Emit notifications**: Call `mcp.notification()` with method `notifications/claude/channel` and params containing `content` (the event body) and optional `meta` (key-value pairs that become tag attributes).
4. **Connect over stdio**: Use `StdioServerTransport` from the MCP SDK. Claude Code spawns the server as a subprocess.

For two-way channels, the server additionally:

5. **Declares tool capability**: Sets `capabilities.tools` to `{}`.
6. **Registers a reply tool**: Handles `ListToolsRequestSchema` (to advertise the tool's schema) and `CallToolRequestSchema` (to execute sends back to the platform).

### 3.4 Notification Format

When a channel emits an event:

```typescript
await mcp.notification({
  method: "notifications/claude/channel",
  params: {
    content: "build failed on main: https://ci.example.com/run/1234",
    meta: { severity: "high", run_id: "1234" },
  },
});
```

Claude sees:

```xml
<channel source="your-channel" severity="high" run_id="1234">
build failed on main: https://ci.example.com/run/1234
</channel>
```

The `source` attribute is set automatically from the server's name. Each key in `meta` becomes a tag attribute (keys must be alphanumeric with underscores; hyphens and other characters are silently dropped).

### 3.5 Reply Tool Pattern

A two-way channel exposes a standard MCP tool. The typical pattern:

```typescript
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a message back over this channel",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: {
            type: "string",
            description: "The conversation to reply in",
          },
          text: { type: "string", description: "The message to send" },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));
```

The `instructions` string tells Claude to extract routing information (like `chat_id`) from the inbound `<channel>` tag and pass it back when calling the reply tool. When Claude replies through a channel, the reply appears on the external platform (Telegram, Discord, etc.), not in the user's terminal. The user sees the inbound message in their terminal but not the outgoing reply text.

## 4. Security Model

### 4.1 Sender Allowlists

An ungated channel is a prompt injection vector. Anyone who can reach the channel's endpoint could put arbitrary text in front of Claude. To prevent this, every approved channel plugin maintains a **sender allowlist**. Only platform IDs that have been explicitly paired are allowed to push messages. All other senders are silently dropped.

The critical rule: **gate on the sender's identity, not the chat or room identity**. In group chats, `message.from.id` and `message.chat.id` differ. Gating on the room would let anyone in an allowlisted group inject messages into the session.

### 4.2 Pairing Flow

Both Telegram and Discord use the same pairing pattern:

1. The user DMs the bot on the platform.
2. The bot replies with a one-time pairing code.
3. The user enters the code in their Claude Code session: `/telegram:access pair <code>`
4. The user's platform ID is added to the allowlist.
5. The user locks down access: `/telegram:access policy allowlist`

### 4.3 Multiple Layers of Control

- **Sender allowlist**: Per-channel gating on individual sender IDs.
- **`--channels` flag**: Controls which channel servers are activated per session. Being in `.mcp.json` is not enough; a server must also be named in `--channels`.
- **Organization policy**: On Team and Enterprise plans, `channelsEnabled` must be explicitly set to `true` by an admin. It is disabled by default.
- **Permission prompts**: Claude Code's normal permission system still applies. If Claude hits a permission prompt while processing a channel event, the session pauses until the user approves locally.

## 5. Memory and Context Management in Long-Running Sessions

Channels are designed for long-running sessions where Claude processes events over extended periods. Understanding how Claude Code manages memory and context in these sessions is essential to understanding channels in practice.

### 5.1 Session Model

Each Claude Code session begins with a **fresh context window**. There is no persistent session state carried over from previous sessions at the conversation level. The session exists for as long as the terminal process is running. When the user exits Claude Code, the session and its conversational context are gone.

For channel-enabled sessions, this means:

- Events only arrive while the session is open. There is no queue or store-and-forward mechanism.
- If the session is not running, events are lost.
- For always-on use, the user must run Claude Code in a background process or persistent terminal.

### 5.2 Context Window and Automatic Compression

Claude Code operates within a finite context window (determined by the underlying model). As the conversation grows with channel events, tool calls, and responses, the context fills up. Claude Code handles this automatically:

- **Automatic context compression**: When the conversation approaches the context window limit, Claude Code compresses prior messages. The system summarizes older parts of the conversation to make room for new content. This happens transparently during the session.
- **Manual compaction**: The user can trigger compaction manually with `/compact`.
- **CLAUDE.md survives compaction**: After compaction, Claude re-reads CLAUDE.md files from disk and re-injects them fresh into the session. Instructions stored in CLAUDE.md are never lost to compaction.
- **Conversational context does not survive compaction**: Instructions or context given only in conversation (not written to CLAUDE.md or auto memory) may be lost during compression. In a long-running channel session with many events, earlier events and their context will eventually be summarized away.

### 5.3 Two Persistence Mechanisms

Claude Code provides two mechanisms for carrying knowledge across the boundary of context compression and across session restarts:

#### CLAUDE.md Files (User-Written)

CLAUDE.md files are markdown files that give Claude persistent instructions. They are loaded into every session at startup and re-injected after compaction. They exist at multiple scopes:

| Scope   | Location                               | Purpose                                      |
| ------- | -------------------------------------- | -------------------------------------------- |
| Project | `./CLAUDE.md` or `./.claude/CLAUDE.md` | Team-shared project instructions             |
| User    | `~/.claude/CLAUDE.md`                  | Personal preferences across all projects     |
| Rules   | `.claude/rules/*.md`                   | Modular, optionally path-scoped instructions |
| Managed | System-level paths                     | Organization-wide policies from IT/DevOps    |

CLAUDE.md files are the primary mechanism for ensuring Claude follows specific instructions reliably across a long-running channel session. They are re-read from disk after every compaction, so they are never summarized away.

#### Auto Memory (Claude-Written)

Auto memory lets Claude accumulate knowledge across sessions without the user writing anything. Claude saves notes for itself as it works: build commands, debugging insights, architecture notes, preferences it discovers from user corrections.

Storage structure:

```
~/.claude/projects/<project>/memory/
├── MEMORY.md          # Index file, first 200 lines loaded at session start
├── debugging.md       # Topic-specific notes
├── api-conventions.md # More topic-specific notes
└── ...
```

Key behaviors:

- **MEMORY.md** (the index) is loaded at the start of every session (first 200 lines).
- **Topic files** are not loaded at startup. Claude reads them on demand when it needs the information.
- Claude decides what's worth saving based on whether the information would be useful in a future conversation.
- Auto memory is machine-local and scoped per git repository.
- All files are plain markdown that the user can edit or delete at any time.

### 5.4 What This Means for Channel Sessions

In a long-running channel session (e.g., Claude monitoring CI alerts via a webhook channel over the course of a workday):

1. **Early events are eventually compressed**. As new channel events arrive and Claude processes them, older events and their associated tool calls are summarized into a compressed representation. The details of early events may not be available verbatim later in the session.

2. **CLAUDE.md instructions persist**. Project instructions, coding standards, and behavioral guidance in CLAUDE.md files survive compaction and remain available throughout the entire session.

3. **Auto memory can bridge sessions**. If Claude discovers something important while processing channel events (e.g., "the CI pipeline requires Redis to be running for integration tests"), it can save this to auto memory. This knowledge then persists into future sessions.

4. **There is no pre-compaction memory flush**. Unlike some other assistant frameworks, Claude Code does not perform a dedicated "save important context to disk" step before compacting. The automatic compression is the only mechanism. If specific information from channel events needs to survive long-term, the user should ask Claude to save it to auto memory or CLAUDE.md, or Claude may do so on its own if it determines the information is worth remembering.

5. **Permission prompts block the session**. If Claude hits a permission prompt while processing a channel event and the user is away, the session pauses. No further events are processed until the prompt is approved. For unattended channel sessions, `--dangerously-skip-permissions` bypasses this, but should only be used in trusted environments.

## 6. Building a Custom Channel

### 6.1 Minimal One-Way Channel (Webhook Receiver)

A minimal channel is a single file that creates an MCP server with the channel capability and forwards HTTP requests as notifications:

```typescript
#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const mcp = new Server(
  { name: "webhook", version: "0.0.1" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions:
      'Events from the webhook channel arrive as <channel source="webhook" ...>. Read them and act, no reply expected.',
  },
);

await mcp.connect(new StdioServerTransport());

Bun.serve({
  port: 8788,
  hostname: "127.0.0.1",
  async fetch(req) {
    const body = await req.text();
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: body,
        meta: { path: new URL(req.url).pathname, method: req.method },
      },
    });
    return new Response("ok");
  },
});
```

Register it in `.mcp.json`:

```json
{
  "mcpServers": {
    "webhook": { "command": "bun", "args": ["./webhook.ts"] }
  }
}
```

During the research preview, custom channels require the development flag:

```bash
claude --dangerously-load-development-channels server:webhook
```

### 6.2 Adding Two-Way Communication

To make a channel two-way, add `tools: {}` to capabilities and register tool handlers:

```typescript
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// In the Server constructor:
capabilities: {
  experimental: { 'claude/channel': {} },
  tools: {},
},
instructions: 'Messages arrive as <channel source="webhook" chat_id="...">. Reply with the reply tool, passing the chat_id from the tag.',

// After the constructor:
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send a message back over this channel',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['chat_id', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'reply') {
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string }
    await yourPlatform.send(chat_id, text)
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})
```

### 6.3 Packaging and Distribution

Custom channels can be packaged as plugins and published to a marketplace. Users install with `/plugin install` and enable per session with `--channels plugin:<name>@<marketplace>`. During the research preview, custom plugins still require `--dangerously-load-development-channels`. To get a channel onto the approved allowlist, submit it to the official marketplace for security review.

## 7. Enterprise Deployment

| Plan type                   | Default behavior                                               |
| --------------------------- | -------------------------------------------------------------- |
| Pro / Max (no organization) | Channels available; users opt in per session with `--channels` |
| Team / Enterprise           | Channels disabled until an admin explicitly enables them       |

Admins enable channels from **claude.ai > Admin settings > Claude Code > Channels**, or by setting `channelsEnabled` to `true` in managed settings. Once enabled, individual users can use `--channels` to opt channel servers into their sessions.

If channels are not enabled at the organization level, the MCP server still connects and its tools work as normal MCP tools, but channel notifications will not arrive. A startup warning informs the user.

## 8. Limitations

- **Research preview**: The `--channels` flag syntax and protocol contract may change. Only plugins from Anthropic's maintained allowlist are accepted without the development flag.
- **Requires claude.ai login**: Console and API key authentication are not supported.
- **No event persistence**: Events only arrive while the session is open. There is no queue, replay, or store-and-forward.
- **No pre-compaction memory flush**: There is no automatic mechanism to save important context to disk before context compression occurs. Long-running sessions will lose the details of earlier events as they are summarized.
- **Permission prompts block processing**: If Claude hits a permission prompt while the user is away, the session pauses until the user returns and approves.
- **Local-only**: The session runs on the user's machine. There is no cloud-hosted or synced session mode for channels.

## Citations

### Documentation

- https://code.claude.com/docs/en/channels — Primary documentation on using channels (Telegram, Discord, fakechat setup, security, enterprise controls, comparison with other features)
- https://code.claude.com/docs/en/channels-reference — Technical reference for building custom channels (MCP server contract, notification format, reply tools, sender gating, packaging as plugins)
- https://code.claude.com/docs/en/memory — How Claude Code manages persistent knowledge across sessions (CLAUDE.md files, auto memory, rules, context survival across compaction)

### Source Code

- https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram — Telegram channel plugin source
- https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord — Discord channel plugin source
- https://www.npmjs.com/package/@modelcontextprotocol/sdk — MCP SDK used to build channel servers
