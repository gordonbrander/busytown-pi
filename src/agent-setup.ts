/**
 * Shared agent setup logic used by both the headless agent extension
 * (agent-extension.ts) and the interactive --agent flag (index.ts).
 * @module
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ExecResult,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  loadAgentDef,
  updateAgentFrontmatter,
  type AgentDef,
  type PiAgentDef,
  type Hooks,
  type HookName,
} from "./file-agent.ts";
import { applyMemoryUpdate, renderMemoryBlocksPrompt } from "./memory/memory.ts";
import { nextTick } from "./lib/promise.ts";
import * as Lines from "./lib/lines.ts";
import { renderTemplate } from "./lib/template.ts";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

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

/** Build the agent-augmented system prompt. */
export const buildAgentSystemPrompt = (
  basePrompt: string,
  agent: AgentDef,
): string =>
  Lines.join([
    basePrompt,
    "",
    `You are the "${agent.id}" agent. ${agent.description}`,
    "",
    agent.body,
    "",
    renderMemoryBlocksPrompt(agent.memoryBlocks),
  ]);

/** Register the update-memory tool for agents with memory blocks. */
export const registerAgentMemoryTool = (
  pi: ExtensionAPI,
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
};

/** Register lifecycle hooks from a pi agent definition. */
export const registerAgentHooks = (
  pi: ExtensionAPI,
  agent: PiAgentDef,
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

/**
 * Resolve a short model pattern (e.g. "sonnet") to a Model object
 * from the registry. Uses fuzzy matching: exact id > partial id/name match.
 * Returns the model object directly so it can be passed to `pi.setModel()`.
 */
export const resolveAgentModel = (
  modelPattern: string,
  modelRegistry: ModelRegistry,
): ReturnType<ModelRegistry["getAvailable"]>[number] | undefined => {
  const models = modelRegistry.getAvailable();

  // Exact id match (case-insensitive)
  const exact = models.find(
    (m) => m.id.toLowerCase() === modelPattern.toLowerCase(),
  );
  if (exact) return exact;

  // Partial match on id or name
  const lower = modelPattern.toLowerCase();
  const matches = models.filter(
    (m) =>
      m.id.toLowerCase().includes(lower) ||
      (m.name && m.name.toLowerCase().includes(lower)),
  );
  if (matches.length === 0) return undefined;

  // Prefer aliases (no date suffix) over dated versions
  const isAlias = (id: string): boolean => !/\d{8}$/.test(id);
  const aliases = matches.filter((m) => isAlias(m.id));
  const dated = matches.filter((m) => !isAlias(m.id));

  if (aliases.length > 0) {
    aliases.sort((a, b) => b.id.localeCompare(a.id));
    return aliases[0];
  }

  dated.sort((a, b) => b.id.localeCompare(a.id));
  return dated[0];
};
