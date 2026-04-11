import type { DatabaseSync } from "node:sqlite";
import { pullNextMatchingEvent, pushEvent } from "./event-queue.ts";
import { abortableSleep, nextTick } from "./lib/promise.ts";
import { loggerOf } from "./lib/json-logger.ts";
import { type AgentProc, type SendFn, type Agent } from "./agent.ts";
import { shouldHandleEventOf } from "./sdk.ts";
import { parseSlug } from "./lib/slug.ts";

const logger = loggerOf({ source: "agent-system.ts" });

export type SystemStats = {
  agents: string[];
};

export type AgentSystem = {
  spawnAgent(config: Agent): Promise<string>;
  disposeAgent(id: string): Promise<void>;
  stats(): SystemStats;
  [Symbol.asyncDispose](): Promise<void>;
};

type SpawnedAgent = {
  id: string;
  listen: string[];
  ignoreSelf: boolean;
  agent: AgentProc;
  abortController: AbortController;
};

export { shouldHandleEventOf } from "./sdk.ts";

export const agentSystemOf = (
  db: DatabaseSync,
  timeout = 1000,
): AgentSystem => {
  logger.debug("Agent system created");
  const systemAbortController = new AbortController();

  // Registry of spawned agents
  const agents: Map<string, SpawnedAgent> = new Map();

  const stats = (): SystemStats => ({
    agents: Array.from(agents.keys()),
  });

  const forkAgentPollLoop = async (entry: SpawnedAgent): Promise<void> => {
    const { id, listen, ignoreSelf, agent, abortController } = entry;

    const signal = AbortSignal.any([
      abortController.signal,
      systemAbortController.signal,
    ]);

    const shouldHandleEvent = shouldHandleEventOf(id, ignoreSelf, listen);

    while (!signal.aborted) {
      try {
        const event = pullNextMatchingEvent(db, id, shouldHandleEvent);

        if (!event) {
          await abortableSleep(timeout, signal);
          continue;
        }

        if (signal.aborted) break;

        await agent.handle(event, { signal });
      } catch (e) {
        logger.warn("Agent error during event handling", {
          agent_id: id,
          error: `${e}`,
        });
      }
    }
  };

  const spawnAgent = async (config: Agent): Promise<string> => {
    systemAbortController.signal.throwIfAborted();
    const { ignoreSelf = true, listen, setup } = config;
    // Make sure ID is valid slug
    const id = parseSlug(config.id);

    if (agents.has(id)) {
      throw new Error(`Agent with id ${id} already registered`);
    }

    logger.debug("Spawning agent", { id });

    const send: SendFn = async (type, payload) => {
      await nextTick();
      pushEvent(db, id, type, payload);
    };

    try {
      const agent = await setup(id, send);
      const abortController = new AbortController();

      const entry: SpawnedAgent = {
        id,
        listen,
        ignoreSelf,
        agent,
        abortController,
      };

      agents.set(id, entry);
      forkAgentPollLoop(entry).catch((e) => {
        logger.error("Agent poll loop crashed", {
          agent_id: id,
          error: `${e}`,
        });
      });

      return id;
    } catch (e) {
      logger.error("Error spawning agent", {
        id,
        error: `${e}`,
      });
      throw e;
    }
  };

  const disposeAgent = async (id: string): Promise<void> => {
    logger.debug("Disposing agent", { id });
    const entry = agents.get(id);
    if (!entry) return;

    // First abort the poll loop
    entry.abortController.abort(new Error("Agent disposed"));
    // Then dispose the agent
    await entry.agent[Symbol.asyncDispose]();
    // Then delete reference. Waiting to delete ref lets us retry dispose if it fails.
    agents.delete(id);
    logger.debug("Disposed agent", { id });
  };

  const disposeSystem = async (): Promise<void> => {
    logger.debug("Disposing agent system");
    if (systemAbortController.signal.aborted) return;
    systemAbortController.abort(new Error("System stopped"));

    const kills = Array.from(agents.keys()).map(disposeAgent);
    await Promise.allSettled(kills);
    agents.clear();
    logger.debug("Disposed agent system");
  };

  return {
    spawnAgent,
    disposeAgent,
    stats,
    [Symbol.asyncDispose]: disposeSystem,
  };
};
