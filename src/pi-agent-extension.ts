/**
 * Extension that is automatically loaded for all busytown Pi subagents.
 * @module
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getOrOpenDb, pushEvent } from "./event-queue.ts";
import { loadAgentDef } from "./file-agent.ts";
import {
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

  // Register busytown tools (push, events, claim)
  const db = getOrOpenDb(dbPath);
  registerBusytownTools(pi, db, agentId);

  // Register lifecycle hooks + memory tool
  const cwd = process.cwd();
  const agent = loadAgentDef(agentFile, cwd);

  // Execute before_agent_start hook if defined
  if (agent.type === "pi" && agent.hooks.before_agent_start) {
    pi.on("before_agent_start", async (event, ctx) => {
      const hookResult = await execHook(
        pi,
        agent.hooks,
        "before_agent_start",
        ctx,
        { prompt: event.prompt },
      );
      if (hookResult && hookResult.code === 0 && hookResult.stdout.trim()) {
        return {
          message: {
            customType: "busytown-hook",
            content: hookResult.stdout,
            display: true,
          },
        };
      }
    });
  }

  if (agent.type === "pi") {
    registerAgentHooks(pi, agent);
  }

  if (Object.keys(agent.memoryBlocks).length > 0) {
    registerAgentMemoryTool(pi, cwd, agentId, agentFile);
  }

  // Log session file path as a busytown event
  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile() ?? "";
    pushEvent(db, agentId, `agent.${agentId}.session_start`, { sessionFile });
  });
};
