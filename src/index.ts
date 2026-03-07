import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { type ArgsDef, parseArgs } from "citty";
import {
  claimEvent,
  getClaimant,
  getEventsSince,
  getOrOpenDb,
  pushEvent,
} from "./event-queue.ts";

import { loadAllAgents } from "./agent.ts";
import { getOrCreateSystem } from "./worker.ts";
import { makeAgentWorker } from "./pi-process.ts";
import { watchAgents } from "./agent-watcher.ts";
import { cleanupGroupAsync } from "./lib/cleanup.ts";
import { nextTick } from "./lib/promise.ts";
import { shellSplit } from "./lib/shell.ts";
import { startWidget, registerEventLogCommand } from "./dashboard.ts";

const resolveDbPath = (projectRoot: string): string =>
  path.join(projectRoot, ".busytown", "events.db");

const resolveAgentsDir = (projectRoot: string): string =>
  path.join(projectRoot, ".pi", "agents");

const resolveCliBin = (): string => {
  // Resolve the CLI binary path relative to this extension
  return path.join(path.dirname(new URL(import.meta.url).pathname), "cli.ts");
};

export default (pi: ExtensionAPI) => {
  const projectRoot = process.cwd();
  const dbPath = resolveDbPath(projectRoot);
  const agentsDir = resolveAgentsDir(projectRoot);
  const cliBin = resolveCliBin();
  const sessionCleanup = cleanupGroupAsync();

  pi.on("session_start", async (_event: unknown, ctx: unknown) => {
    await nextTick();

    const db = getOrOpenDb(dbPath);
    sessionCleanup.add(() => {
      db.close();
      getOrOpenDb.cache.delete(dbPath);
    });

    const system = getOrCreateSystem("pi", db, 1000);
    sessionCleanup.add(async () => {
      await system.stop();
      getOrCreateSystem.cache.delete("pi");
    });

    // Load agents with listen fields and spawn workers
    const agents = loadAllAgents(agentsDir);
    const toWorker = makeAgentWorker(db, projectRoot, cliBin);

    for (const agent of agents) {
      if (agent.listen.length === 0) continue;
      try {
        system.spawn(toWorker(agent));
      } catch (err) {
        console.error(`Failed to spawn worker for agent "${agent.id}":`, err);
      }
    }

    // Start watching for agent file changes
    const stopWatcher = watchAgents(db, agentsDir, system, projectRoot, cliBin);
    sessionCleanup.add(stopWatcher);

    pushEvent(db, "sys", "sys.lifecycle.start");

    // Start the dashboard widget (agent status below editor)
    const stopWidget = startWidget(db, agents, ctx as ExtensionContext);
    sessionCleanup.add(stopWidget);

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
        const event = pushEvent(db, "host", params.type as string, payload);
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
        tail: Type.Optional(
          Type.Integer({
            description: "Number of recent events to show (default: 20)",
          }),
        ),
        type: Type.Optional(
          Type.String({ description: "Filter by event type" }),
        ),
      }),
      async execute(_toolCallId, params) {
        await nextTick();
        const events = getEventsSince(db, {
          tail: (params.tail as number) ?? 20,
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
        worker: Type.String({ description: "Worker ID claiming the event" }),
      }),
      async execute(_toolCallId, params) {
        await nextTick();
        const claimed = claimEvent(
          db,
          params.worker as string,
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

    const pushArgs = {
      type: {
        type: "positional" as const,
        description: "Event type",
        required: true,
      },
      payload: {
        type: "positional" as const,
        description: "Event payload as JSON (default: {})",
      },
    } satisfies ArgsDef;

    pi.registerCommand("busytown-push", {
      description:
        "Push an event to the Busytown event queue. Usage: /busytown-push <type> [payload-json]",
      handler: async (raw, ctx) => {
        await nextTick();
        const args = parseArgs(shellSplit(raw ?? ""), pushArgs);
        if (!args.type) {
          ctx.ui.notify(
            "Usage: /busytown-push <type> [payload-json]",
            "warning",
          );
          return;
        }
        try {
          const payload = args.payload ? JSON.parse(args.payload) : {};
          const event = pushEvent(db, "host", args.type, payload);
          ctx.ui.notify(`Pushed event #${event.id} (${event.type})`, "info");
        } catch (err) {
          ctx.ui.notify(`Invalid payload JSON: ${err}`, "error");
        }
      },
    });

    const eventsArgs = {
      tail: {
        type: "string" as const,
        alias: "n",
        description: "Number of recent events to show (default: 20)",
      },
      type: {
        type: "string" as const,
        alias: "t",
        description: "Filter by event type",
      },
    } satisfies ArgsDef;

    pi.registerCommand("busytown-events", {
      description:
        "List recent events from the Busytown event queue. Usage: /busytown-events [--tail N] [--type filter]",
      handler: async (raw, ctx) => {
        await nextTick();
        const args = parseArgs(shellSplit(raw ?? ""), eventsArgs);
        const tail = args.tail ? parseInt(args.tail, 10) : 20;
        const events = getEventsSince(db, {
          tail: isNaN(tail) ? 20 : tail,
          filterType: args.type,
        });
        if (events.length === 0) {
          ctx.ui.notify("No events found", "info");
          return;
        }
        const summary = events
          .map(
            (e) =>
              `#${e.id} [${e.type}] worker=${e.worker_id} ts=${e.timestamp}`,
          )
          .join("\n");
        ctx.ui.notify(`${events.length} event(s):\n${summary}`, "info");
      },
    });

    const claimArgs = {
      event: {
        type: "positional" as const,
        description: "Event ID",
        required: true,
      },
      worker: {
        type: "positional" as const,
        description: "Worker ID",
        required: true,
      },
    } satisfies ArgsDef;

    pi.registerCommand("busytown-claim", {
      description:
        "Claim an event so no other agent processes it. Usage: /busytown-claim <event-id> <worker-id>",
      handler: async (raw, ctx) => {
        await nextTick();
        const args = parseArgs(shellSplit(raw ?? ""), claimArgs);
        const eventId = parseInt(args.event, 10);
        if (isNaN(eventId) || !args.worker) {
          ctx.ui.notify(
            "Usage: /busytown-claim <event-id> <worker-id>",
            "warning",
          );
          return;
        }
        const claimed = claimEvent(db, args.worker, eventId);
        const claimant = getClaimant(db, eventId);
        ctx.ui.notify(
          claimed
            ? `Event #${eventId} claimed by ${claimant}`
            : `Event #${eventId} already claimed by ${claimant}`,
          claimed ? "info" : "warning",
        );
      },
    });
  });

  pi.on("session_shutdown", async () => {
    const db = getOrOpenDb(dbPath);
    pushEvent(db, "sys", "sys.lifecycle.finish");
    await sessionCleanup();
  });
};
