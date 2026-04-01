/**
 * Extension that is automatically loaded for all busytown Pi subagents.
 * @module
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  claimEvent,
  getClaimant,
  getEventsSince,
  getOrOpenDb,
  pushEvent,
} from "./event-queue.ts";
import { loadAgentDef } from "./file-agent.ts";
import {
  buildAgentSystemPrompt,
  registerAgentMemoryTool,
  registerAgentHooks,
} from "./agent-setup.ts";
import { nextTick } from "./lib/promise.ts";
import { renderTemplate } from "./lib/template.ts";

export default (pi: ExtensionAPI) => {
  const dbPath = process.env.BUSYTOWN_DB_PATH;
  const agentFile = process.env.BUSYTOWN_AGENT_FILE;
  const agentId = process.env.BUSYTOWN_AGENT_ID;

  if (!dbPath || !agentFile || !agentId) {
    // Not running as a busytown sub-agent — skip
    return;
  }

  // Build system prompt via before_agent_start
  pi.on("before_agent_start", async (event, ctx) => {
    const agent = loadAgentDef(agentFile);
    const systemPrompt = buildAgentSystemPrompt(event.systemPrompt, agent);

    const result: {
      systemPrompt: string;
      message?: { customType: string; content: string; display: boolean };
    } = { systemPrompt };

    if (agent.type === "pi" && agent.hooks.before_agent_start) {
      // Inline hook execution for before_agent_start — uses the same
      // renderTemplate / exec pattern but needs the prompt extra.
      const rendered = renderTemplate(agent.hooks.before_agent_start, {
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile() ?? "",
        model: ctx.model?.id ?? "",
        provider: ctx.model?.provider ?? "",
        timestamp: new Date().toISOString(),
        prompt: event.prompt,
      });
      const hookResult = await pi.exec("sh", ["-c", rendered], {
        timeout: 30_000,
      });
      if (hookResult && hookResult.code === 0 && hookResult.stdout.trim()) {
        result.message = {
          customType: "busytown-hook",
          content: hookResult.stdout,
          display: true,
        };
      }
    }

    return result;
  });

  // Register busytown tools (push, events, claim) — these depend on DB from env vars
  const db = getOrOpenDb(dbPath);

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
      const event = pushEvent(db, agentId, params.type as string, payload);
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
      type: Type.Optional(Type.String({ description: "Filter by event type" })),
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
      agent: Type.Optional(
        Type.String({
          description: `Agent ID claiming the event (default: "${agentId}")`,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      await nextTick();
      const claimingAgent = (params.agent as string) ?? agentId;
      const claimed = claimEvent(db, claimingAgent, params.event_id as number);
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

  // Register lifecycle hooks + memory tool
  const agent = loadAgentDef(agentFile);

  if (agent.type === "pi") {
    registerAgentHooks(pi, agent);
  }

  if (Object.keys(agent.memoryBlocks).length > 0) {
    registerAgentMemoryTool(pi, agentFile);
  }
};
