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
import {
  loadAgentDef,
  updateAgentFile,
} from "./agent.ts";
import { applyMemoryUpdate, renderMemoryBlocksPrompt } from "./memory.ts";
import { nextTick } from "./lib/promise.ts";

export default (pi: ExtensionAPI) => {
  const dbPath = process.env.BUSYTOWN_DB_PATH;
  const agentFile = process.env.BUSYTOWN_AGENT_FILE;
  const agentId = process.env.BUSYTOWN_AGENT_ID;

  if (!dbPath || !agentFile || !agentId) {
    // Not running as a busytown sub-agent — skip
    return;
  }

  // Build system prompt via before_agent_start
  pi.on("before_agent_start", (event) => {
    const agent = loadAgentDef(agentFile);

    const systemParts: string[] = [
      event.systemPrompt,
      `You are the "${agent.id}" agent. ${agent.description}`,
    ];

    if (agent.body) {
      systemParts.push(agent.body);
    }

    const memoryPrompt = renderMemoryBlocksPrompt(agent.memoryBlocks);
    if (memoryPrompt) {
      systemParts.push(memoryPrompt);
    }

    return {
      systemPrompt: systemParts.join("\n\n"),
    };
  });

  // Register tools
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
      worker: Type.Optional(
        Type.String({
          description: `Worker ID claiming the event (default: "${agentId}")`,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      await nextTick();
      const worker = (params.worker as string) ?? agentId;
      const claimed = claimEvent(db, worker, params.event_id as number);
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

  // updateMemory tool — only register if agent has memory blocks
  const agent = loadAgentDef(agentFile);
  if (Object.keys(agent.memoryBlocks).length > 0) {
    pi.registerTool({
      name: "updateMemory",
      label: "Update Memory",
      description:
        "Update a persistent memory block. If oldText is provided, it is replaced with newText. " +
        "If oldText is omitted, newText is appended. Content is truncated to the block's character limit.",
      parameters: Type.Object({
        blockKey: Type.String({
          description:
            "Block to update (e.g. 'agent'). Must be an existing block.",
        }),
        newText: Type.String({
          description:
            "Replacement text, or text to append if oldText is omitted.",
        }),
        oldText: Type.Optional(
          Type.String({
            description: "Text to find and replace. Omit to append instead.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        await nextTick();
        const blockKey = params.blockKey as string;
        const newText = params.newText as string;
        const oldText = params.oldText as string | undefined;

        // Re-read agent file to get current state
        const currentAgent = loadAgentDef(agentFile);
        const block = currentAgent.memoryBlocks[blockKey];

        if (!block) {
          const available = Object.keys(currentAgent.memoryBlocks).join(", ");
          return {
            content: [
              {
                type: "text",
                text: `Error: block "${blockKey}" not found. Available blocks: ${available}`,
              },
            ],
            details: {},
          };
        }

        try {
          const result = applyMemoryUpdate(
            block.value,
            block.charLimit,
            newText,
            oldText,
          );

          // Write back to agent file
          updateAgentFile(agentFile, (frontmatter) => {
            const mb = (frontmatter.memory_blocks ?? {}) as Record<
              string,
              { value?: string }
            >;
            if (mb[blockKey]) {
              mb[blockKey].value = result.value;
            }
            return { ...frontmatter, memory_blocks: mb };
          });

          const usage = `${result.value.length}/${block.charLimit}`;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  blockKey,
                  usage,
                  truncated: result.truncated,
                  value: result.value,
                }),
              },
            ],
            details: {},
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: {},
          };
        }
      },
    });
  }
};
