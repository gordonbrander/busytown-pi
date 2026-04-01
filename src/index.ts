import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { parseArgs } from "citty";
import {
  claimEvent,
  getClaimant,
  getEventsSince,
  getOrOpenDb,
  pushEvent,
} from "./event-queue.ts";
import { cleanupGroupAsync } from "./lib/cleanup.ts";
import { nextTick } from "./lib/promise.ts";
import { shellSplit } from "./lib/shell.ts";
import {
  startWidget,
  startNotifier,
  registerEventLogCommand,
} from "./dashboard.ts";
import { spawnDaemon, stopDaemon, getDaemonStatus } from "./daemon.ts";
import {
  buildAgentSystemPrompt,
  registerAgentMemoryTool,
  registerAgentHooks,
  resolveAgentModel,
} from "./agent-setup.ts";
import { listAgentDefs, loadAgentDef } from "./file-agent.ts";
import { collect } from "./lib/generator.ts";

const resolveDbPath = (projectRoot: string): string =>
  path.join(projectRoot, ".busytown", "events.db");

export default (pi: ExtensionAPI) => {
  const projectRoot = process.cwd();
  const dbPath = resolveDbPath(projectRoot);
  const sessionCleanup = cleanupGroupAsync();

  // Register --agent flag
  pi.registerFlag("agent", {
    description: "Boot as a busytown agent (e.g. --agent code)",
    type: "string",
    default: "",
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    await nextTick();

    const db = getOrOpenDb(dbPath);
    sessionCleanup.add(() => {
      db.close();
      getOrOpenDb.cache.delete(dbPath);
    });

    // Auto-start the daemon
    const result = await spawnDaemon(projectRoot);
    if (result.ok) {
      ctx.ui.notify(`Busytown daemon running (pid ${result.pid})`, "info");
    } else {
      ctx.ui.notify("Busytown daemon failed to start", "error");
    }

    // Load agents for widget display (read-only, no spawning)
    const agents = await collect(
      listAgentDefs(path.join(projectRoot, ".pi", "agents")),
    );

    // Start the dashboard widget (agent status + daemon indicator)
    const stopWidget = startWidget(db, agents, ctx, projectRoot);
    sessionCleanup.add(stopWidget);

    // Fire-and-forget TUI notification for every event (polls DB)
    const stopNotifier = startNotifier(db, ctx);
    sessionCleanup.add(stopNotifier);

    // Register /busytown overlay command
    registerEventLogCommand(pi, db);

    // Register tools
    pi.registerTool({
      name: "busytown-push",
      label: "Busytown Push",
      description:
        "Push an event to the Busytown event queue to trigger agent workflows. " +
        "Common event types: plan.request, code.request, review.request",
      parameters: Type.Object({
        type: Type.String({ description: "Event type (e.g. 'plan.request')" }),
        payload: Type.Optional(
          Type.String({ description: "JSON payload string (default: '{}')" }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        await nextTick();
        const payload = params.payload
          ? JSON.parse(params.payload as string)
          : {};
        const event = pushEvent(db, "pi", params.type as string, payload);
        return {
          content: [{ type: "text", text: JSON.stringify(event, null, 2) }],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: "busytown-events",
      label: "Busytown Events",
      description: "List recent events from the Busytown event queue",
      parameters: Type.Object({
        type: Type.Optional(
          Type.String({ description: "Filter by event type" }),
        ),
        tail: Type.Optional(
          Type.Integer({
            description: "Number of recent events to show (default: 20)",
          }),
        ),
        since: Type.Optional(
          Type.Integer({
            description:
              "List events since this event ID (mutually exclusive with tail)",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        await nextTick();
        const sinceId = params.since as number | undefined;
        const events = getEventsSince(db, {
          ...(sinceId != null
            ? { sinceId }
            : { tail: (params.tail as number) ?? 20 }),
          filterType: params.type as string,
        });
        const ljson = events.map((e) => JSON.stringify(e)).join("\n");
        return {
          content: [{ type: "text", text: ljson }],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: "busytown-claim",
      label: "Busytown Claim",
      description: "Claim an event so no other agent processes it",
      parameters: Type.Object({
        event_id: Type.Integer({ description: "Event ID to claim" }),
        agent: Type.String({ description: "Agent ID claiming the event" }),
      }),
      async execute(_toolCallId, params) {
        await nextTick();
        const claimed = claimEvent(
          db,
          params.agent as string,
          params.event_id as number,
        );
        const claimant = getClaimant(db, params.event_id as number);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ claimed, claimant }, null, 2),
            },
          ],
          details: {},
        };
      },
    });

    // Register commands (slash-command equivalents of the tools)

    pi.registerCommand("busytown-push", {
      description:
        "Push an event to the Busytown event queue. Usage: /busytown-push <type> [payload-json] [--agent name]",
      handler: async (raw, ctx) => {
        await nextTick();
        const args = parseArgs(shellSplit(raw ?? ""), {
          type: {
            type: "positional" as const,
            description: "Event type",
            required: true,
          },
          agent: {
            type: "string" as const,
            alias: "a",
            description: "Agent ID (default: pi)",
            default: "pi",
          },
          payload: {
            type: "positional" as const,
            description: "Event payload as JSON (default: {})",
            default: "{}",
          },
        });
        if (!args.type) {
          ctx.ui.notify(
            "Usage: /busytown-push <type> [--agent name] [payload-json]",
            "warning",
          );
          return;
        }
        try {
          const payload = JSON.parse(args.payload);
          const event = pushEvent(db, args.agent, args.type, payload);
          ctx.ui.notify(`Pushed event #${event.id} (${event.type})`, "info");
        } catch (err) {
          ctx.ui.notify(`Invalid payload JSON: ${err}`, "error");
        }
      },
    });

    pi.registerCommand("busytown-events", {
      description:
        "List recent events from the Busytown event queue. Usage: /busytown-events [--type filter] [--since ID] [--tail N]",
      handler: async (raw, ctx) => {
        await nextTick();
        const args = parseArgs(shellSplit(raw ?? ""), {
          type: {
            type: "string" as const,
            alias: "t",
            description: "Filter by event type",
          },
          since: {
            type: "string" as const,
            alias: "s",
            description: "List events since this event ID",
          },
          tail: {
            type: "string" as const,
            alias: "n",
            description: "Number of recent events to show (default: 20)",
          },
        });
        const sinceId = args.since ? parseInt(args.since, 10) : undefined;
        const tail = args.tail ? parseInt(args.tail, 10) : 20;
        const events = getEventsSince(db, {
          ...(sinceId && !isNaN(sinceId)
            ? { sinceId }
            : { tail: isNaN(tail) ? 20 : tail }),
          filterType: args.type,
        });
        if (events.length === 0) {
          ctx.ui.notify("No events found", "info");
          return;
        }
        const lines = events.map((e) => JSON.stringify(e)).join("\n");
        ctx.ui.notify(lines, "info");
      },
    });

    pi.registerCommand("busytown-claim", {
      description:
        "Claim an event so no other agent processes it. Usage: /busytown-claim <event-id> <agent-id>",
      handler: async (raw, ctx) => {
        await nextTick();
        const args = parseArgs(shellSplit(raw ?? ""), {
          event: {
            type: "positional" as const,
            description: "Event ID",
            required: true,
          },
          agent: {
            type: "positional" as const,
            description: "Agent ID",
            required: true,
          },
        });
        const eventId = parseInt(args.event, 10);
        if (isNaN(eventId) || !args.agent) {
          ctx.ui.notify(
            "Usage: /busytown-claim <event-id> <agent-id>",
            "warning",
          );
          return;
        }
        const claimed = claimEvent(db, args.agent, eventId);
        const claimant = getClaimant(db, eventId);
        ctx.ui.notify(
          claimed
            ? `Event #${eventId} claimed by ${claimant}`
            : `Event #${eventId} already claimed by ${claimant}`,
          claimed ? "info" : "warning",
        );
      },
    });

    // /busytown-start — idempotent daemon start
    pi.registerCommand("busytown-start", {
      description: "Start the Busytown daemon (idempotent)",
      handler: async (_raw, ctx) => {
        await nextTick();
        const status = getDaemonStatus(projectRoot);
        if (status.running) {
          ctx.ui.notify(
            `Busytown daemon already running (pid ${status.pid})`,
            "info",
          );
          return;
        }
        const res = await spawnDaemon(projectRoot);
        if (res.ok) {
          ctx.ui.notify(`Busytown daemon started (pid ${res.pid})`, "info");
        } else {
          ctx.ui.notify("Busytown daemon failed to start", "error");
        }
      },
    });

    // /busytown-stop — idempotent daemon stop
    pi.registerCommand("busytown-stop", {
      description: "Stop the Busytown daemon",
      handler: async (_raw, ctx) => {
        await nextTick();
        const res = await stopDaemon(projectRoot);
        if (!res.wasRunning) {
          ctx.ui.notify("Busytown daemon is not running", "info");
        } else if (res.ok) {
          ctx.ui.notify("Busytown daemon stopped", "info");
        } else {
          ctx.ui.notify("Busytown daemon did not stop within 5s", "error");
        }
      },
    });

    // /busytown-reload — reload agent definitions
    pi.registerCommand("busytown-reload", {
      description: "Reload agent definitions (sends sys.reload event)",
      handler: async (_raw, ctx) => {
        await nextTick();
        const event = pushEvent(db, "pi", "sys.reload");
        ctx.ui.notify(`Pushed sys.reload event #${event.id}`, "info");
      },
    });

    // --agent flag: boot as a busytown agent persona
    const agentName = pi.getFlag("agent") as string;
    if (agentName) {
      const agentsDir = path.join(projectRoot, ".pi", "agents");
      const agentFile = path.join(agentsDir, `${agentName}.md`);
      const agent = loadAgentDef(agentFile);

      // Inject agent system prompt on every turn
      pi.on("before_agent_start", async (event) => {
        const currentAgent = loadAgentDef(agentFile);
        return {
          systemPrompt: buildAgentSystemPrompt(
            event.systemPrompt,
            currentAgent,
          ),
        };
      });

      // Set the model if the agent defines one
      if (agent.type === "pi" && agent.model) {
        const model = resolveAgentModel(agent.model, ctx.modelRegistry);
        if (model) {
          await pi.setModel(model);
        } else {
          ctx.ui.notify(
            `Agent "${agent.id}": model "${agent.model}" not found`,
            "warning",
          );
        }
      }

      // Register the update-memory tool if agent has memory blocks
      if (Object.keys(agent.memoryBlocks).length > 0) {
        registerAgentMemoryTool(pi, agentFile);
      }

      // Register lifecycle hooks for pi agents
      if (agent.type === "pi") {
        registerAgentHooks(pi, agent);
      }

      // Show agent persona in status bar
      ctx.ui.setStatus("agent", `🤖 ${agent.id}`);
    }
  });

  pi.on("session_shutdown", async () => {
    // Don't stop the daemon on pi exit — it's intentionally independent
    await sessionCleanup();
  });
};
