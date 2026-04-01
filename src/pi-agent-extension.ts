/**
 * Extension that is automatically loaded for all busytown Pi subagents.
 * @module
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getOrOpenDb } from "./event-queue.ts";
import { loadAgentDef } from "./file-agent.ts";
import {
  buildAgentSystemPrompt,
  execHook,
  registerAgentMemoryTool,
  registerAgentHooks,
  registerBusytownTools,
} from "./pi-agent-shared.ts";

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
      const hookResult = await execHook(
        pi,
        agent.hooks,
        "before_agent_start",
        ctx,
        { prompt: event.prompt },
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

  // Register busytown tools (push, events, claim)
  const db = getOrOpenDb(dbPath);
  registerBusytownTools(pi, db, agentId);

  // Register lifecycle hooks + memory tool
  const agent = loadAgentDef(agentFile);

  if (agent.type === "pi") {
    registerAgentHooks(pi, agent);
  }

  if (Object.keys(agent.memoryBlocks).length > 0) {
    registerAgentMemoryTool(pi, agentFile);
  }
};
