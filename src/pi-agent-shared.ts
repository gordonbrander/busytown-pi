/**
 * Shared agent setup logic used by both the headless agent extension
 * (pi-agent-extension.ts) and the interactive --agent flag (index.ts).
 * @module
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ExecResult,
} from "@mariozechner/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import { Type } from "@sinclair/typebox";
import {
  claimEvent,
  getClaimant,
  getEventsSince,
  pushEvent,
} from "./event-queue.ts";
import {
  loadAgentDef,
  type AgentDef,
  type PiAgentDef,
  type PiRpcAgentDef,
  type Hooks,
  type HookName,
} from "./file-agent.ts";
import {
  applyMemoryUpdate,
  readMemoryBlockValue,
  writeMemoryBlockValue,
  renderMemoryBlocksPrompt,
} from "./memory/memory.ts";
import { nextTick } from "./lib/promise.ts";
import { renderTemplate } from "./lib/template.ts";

/** Best-guess provider from a model ID string. */
export const guessProvider = (model: string): string | undefined => {
  if (model.startsWith("claude-")) return "anthropic";
  if (/^(gpt-|o[1-9]-)/.test(model)) return "openai";
  return undefined;
};

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

export const execHook = async (
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

/** Build the agent-specific append prompt. */
export const buildAgentAppendPrompt = (agent: AgentDef): string => {
  return [
    `You are the "${agent.id}" agent. ${agent.description}`,
    "",
    agent.body,
    "",
    renderMemoryBlocksPrompt(agent.memoryBlocks),
  ].join("\n");
};

/** Register the three busytown queue tools (push, events, claim). */
export const registerBusytownTools = (
  pi: ExtensionAPI,
  db: DatabaseSync,
  defaultAgentId: string,
): void => {
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
      const event = pushEvent(
        db,
        defaultAgentId,
        params.type as string,
        payload,
      );
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
          description: `Agent ID claiming the event (default: "${defaultAgentId}")`,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      await nextTick();
      const claimingAgent = (params.agent as string) ?? defaultAgentId;
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
};

/** Register the update-memory tool for agents with memory blocks. */
export const registerAgentMemoryTool = (
  pi: ExtensionAPI,
  cwd: string,
  agentId: string,
  agentFile: string,
): void => {
  pi.registerTool({
    name: "update-memory",
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

      // Re-read agent def to get block schema (description, charLimit)
      const currentAgent = loadAgentDef(agentFile, cwd);
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
        // Read current value from disk
        const currentValue = readMemoryBlockValue(cwd, agentId, blockKey);
        const result = applyMemoryUpdate(
          currentValue,
          block.charLimit,
          newText,
          oldText,
        );

        // Write back to disk
        writeMemoryBlockValue(cwd, agentId, blockKey, result.text);

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
};

/** Register lifecycle hooks from a pi or pi-rpc agent definition. */
export const registerAgentHooks = (
  pi: ExtensionAPI,
  agent: PiAgentDef | PiRpcAgentDef,
): void => {
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
};
