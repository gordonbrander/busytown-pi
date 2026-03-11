/**
 * Extension that is automatically loaded for all busytown Pi subagents.
 * @module
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ExecResult,
} from "@mariozechner/pi-coding-agent";
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
  updateAgentFrontmatter,
  type Hooks,
  type HookName,
} from "./agent.ts";
import { applyMemoryUpdate, renderMemoryBlocksPrompt } from "./memory.ts";
import { nextTick } from "./lib/promise.ts";
import * as Lines from "./lib/lines.ts";
import { renderTemplate } from "./lib/template.ts";

const HOOK_TIMEOUT = 30_000;

const buildHookContext = (
  ctx: ExtensionContext,
  extras: Record<string, unknown> = {},
): Record<string, unknown> => ({
  cwd: ctx.cwd,
  sessionFile: ctx.sessionManager.getSessionFile() ?? "",
  model: ctx.model?.id ?? "",
  provider: ctx.model?.provider ?? "",
  timestamp: new Date().toISOString(),
  ...extras,
});

const execHook = async (
  pi: ExtensionAPI,
  hooks: Hooks,
  hookName: HookName,
  ctx: ExtensionContext,
  extras: Record<string, unknown> = {},
): Promise<ExecResult | undefined> => {
  const command = hooks[hookName];
  if (!command) return undefined;
  const rendered = renderTemplate(command, buildHookContext(ctx, extras));
  return pi.exec("sh", ["-c", rendered], { timeout: HOOK_TIMEOUT });
};

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

    const systemPrompt = Lines.join([
      event.systemPrompt,
      "",
      `You are the "${agent.id}" agent. ${agent.description}`,
      "",
      agent.body,
      "",
      renderMemoryBlocksPrompt(agent.memoryBlocks),
    ]);

    const result: {
      systemPrompt: string;
      message?: { customType: string; content: string; display: boolean };
    } = { systemPrompt };

    if (agent.type === "pi" && agent.hooks.before_agent_start) {
      const hookResult = await execHook(
        pi,
        agent.hooks,
        "before_agent_start",
        ctx,
        {
          prompt: event.prompt,
        },
      );
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

  // Register lifecycle hooks
  const agent = loadAgentDef(agentFile);

  if (agent.type === "pi") {
    const { hooks } = agent;

    // Fire-and-forget hooks
    if (hooks.session_start) {
      pi.on("session_start", async (_event, ctx) => {
        await execHook(pi, hooks, "session_start", ctx);
      });
    }
    if (hooks.session_shutdown) {
      pi.on("session_shutdown", async (_event, ctx) => {
        await execHook(pi, hooks, "session_shutdown", ctx);
      });
    }
    if (hooks.session_switch) {
      pi.on("session_switch", async (event, ctx) => {
        await execHook(pi, hooks, "session_switch", ctx, {
          reason: event.reason,
          previousSessionFile: event.previousSessionFile ?? "",
        });
      });
    }
    if (hooks.session_fork) {
      pi.on("session_fork", async (event, ctx) => {
        await execHook(pi, hooks, "session_fork", ctx, {
          previousSessionFile: event.previousSessionFile ?? "",
        });
      });
    }
    if (hooks.session_compact) {
      pi.on("session_compact", async (_event, ctx) => {
        await execHook(pi, hooks, "session_compact", ctx);
      });
    }
    if (hooks.session_tree) {
      pi.on("session_tree", async (_event, ctx) => {
        await execHook(pi, hooks, "session_tree", ctx);
      });
    }
    if (hooks.agent_start) {
      pi.on("agent_start", async (_event, ctx) => {
        await execHook(pi, hooks, "agent_start", ctx);
      });
    }
    if (hooks.agent_end) {
      pi.on("agent_end", async (_event, ctx) => {
        await execHook(pi, hooks, "agent_end", ctx);
      });
    }
    if (hooks.turn_start) {
      pi.on("turn_start", async (event, ctx) => {
        await execHook(pi, hooks, "turn_start", ctx, {
          turnIndex: event.turnIndex,
        });
      });
    }
    if (hooks.turn_end) {
      pi.on("turn_end", async (event, ctx) => {
        await execHook(pi, hooks, "turn_end", ctx, {
          turnIndex: event.turnIndex,
        });
      });
    }
    if (hooks.tool_result) {
      pi.on("tool_result", async (event, ctx) => {
        await execHook(pi, hooks, "tool_result", ctx, {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
        });
      });
    }
    if (hooks.input) {
      pi.on("input", async (event, ctx) => {
        await execHook(pi, hooks, "input", ctx, {
          text: event.text,
          source: event.source,
          prompt: event.text,
        });
      });
    }
    if (hooks.model_select) {
      pi.on("model_select", async (event, ctx) => {
        await execHook(pi, hooks, "model_select", ctx, {
          source: event.source,
          previousModel: event.previousModel?.id ?? "",
          previousProvider: event.previousModel?.provider ?? "",
        });
      });
    }

    // Cancellation hooks — non-zero exit → cancel
    if (hooks.session_before_switch) {
      pi.on("session_before_switch", async (event, ctx) => {
        const result = await execHook(pi, hooks, "session_before_switch", ctx, {
          reason: event.reason,
        });
        if (result && result.code !== 0) return { cancel: true };
      });
    }
    if (hooks.session_before_fork) {
      pi.on("session_before_fork", async (event, ctx) => {
        const result = await execHook(pi, hooks, "session_before_fork", ctx, {
          entryId: event.entryId,
        });
        if (result && result.code !== 0) return { cancel: true };
      });
    }
    if (hooks.session_before_compact) {
      pi.on("session_before_compact", async (_event, ctx) => {
        const result = await execHook(pi, hooks, "session_before_compact", ctx);
        if (result && result.code !== 0) return { cancel: true };
      });
    }
    if (hooks.session_before_tree) {
      pi.on("session_before_tree", async (_event, ctx) => {
        const result = await execHook(pi, hooks, "session_before_tree", ctx);
        if (result && result.code !== 0) return { cancel: true };
      });
    }

    // tool_call — non-zero exit → block with reason
    if (hooks.tool_call) {
      pi.on("tool_call", async (event, ctx) => {
        const result = await execHook(pi, hooks, "tool_call", ctx, {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        });
        if (result && result.code !== 0) {
          return { block: true, reason: result.stderr || "Blocked by hook" };
        }
      });
    }
  }

  // updateMemory tool — only register if agent has memory blocks
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
          updateAgentFrontmatter(agentFile, (frontmatter) => {
            const mb = frontmatter.memory_blocks ?? {};
            if (Object.hasOwn(mb, blockKey)) {
              mb[blockKey].value = result.text;
            }
            return { ...frontmatter, memory_blocks: mb };
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  blockKey,
                  charCount: result.text.length,
                  charLimit: block.charLimit,
                  truncated: result.truncated,
                  value: result.text,
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
