import type { DatabaseSync } from "node:sqlite";
import { eventMatches, type Event } from "./lib/event.ts";
import { pullNextMatchingEvent, pushEvent } from "./event-queue.ts";
import { abortableSleep } from "./lib/promise.ts";
import { asyncDispose } from "./lib/dispose.ts";
import { loggerOf } from "./lib/json-logger.ts";
import { type Agent } from "./agent.ts";

const logger = loggerOf({ source: "agent-system.ts" });

export type SystemStats = {
  agents: string[];
};

export type AgentSystem = {
  registerAgent: (agent: Agent) => string;
  disposeAgent: (id: string) => Promise<void>;
  stats: () => SystemStats;
  [Symbol.asyncDispose](): Promise<void>;
};

export const agentSystemOf = (
  db: DatabaseSync,
  timeout = 1000,
): AgentSystem => {
  logger.debug("Agent system created");
  const systemAbortController = new AbortController();
  // Registry of agents
  const agents: Map<string, Agent> = new Map();

  const stats = (): SystemStats => {
    return {
      agents: Array.from(agents.keys()),
    };
  };

  const forkAgentPollLoop = async (agent: Agent): Promise<void> => {
    // If either the agent or the system is disposed, abort the loop
    const signal = AbortSignal.any([
      agent.disposed,
      systemAbortController.signal,
    ]);

    const shouldHandleEvent = (event: Event) => {
      if (agent.ignoreSelf && event.agent_id === agent.id) {
        return false;
      }
      return eventMatches(event, agent.listen);
    };

    try {
      while (!signal.aborted) {
        const event = pullNextMatchingEvent(db, agent.id, shouldHandleEvent);

        if (!event) {
          await abortableSleep(timeout, signal);
          continue;
        }

        for await (const draft of agent.stream(event)) {
          // Break the stream if either agent or system aborted.
          // This will run ReadableStream.cancel() and clean up resources.
          if (signal.aborted) {
            break;
          }
          pushEvent(db, agent.id, draft.type, draft.payload);
        }
      }
    } catch (e) {
      logger.warn("Agent poll loop error", { error: `${e}` });
    } finally {
      await asyncDispose(agent);
    }
  };

  const registerAgent = (agent: Agent): string => {
    systemAbortController.signal.throwIfAborted();
    agent.disposed.throwIfAborted();

    if (agents.has(agent.id)) {
      throw new Error(`Agent with id ${agent.id} already registered`);
    }

    logger.debug("Register agent", { id: agent.id });

    // Automatically unregister agent if killed
    agent.disposed.addEventListener(
      "abort",
      () => {
        agents.delete(agent.id);
      },
      { once: true },
    );

    forkAgentPollLoop(agent);

    agents.set(agent.id, agent);

    return agent.id;
  };

  const disposeAgent = async (id: string): Promise<void> => {
    logger.debug("Disposing agent", { id });
    const agent = agents.get(id);
    if (!agent) {
      return;
    }
    // Clean up and automatically unregister via abort event
    await asyncDispose(agent);
    logger.debug("Disposed agent", { id });
  };

  const disposeSystem = async (): Promise<void> => {
    logger.debug("Disposing agent system");
    if (systemAbortController.signal.aborted) {
      return;
    }
    systemAbortController.abort(new Error("System stopped"));
    const kills = Array.from(agents.keys()).map(disposeAgent);
    await Promise.allSettled(kills);
    agents.clear();
    logger.debug("Disposed agent system");
  };

  return {
    registerAgent,
    disposeAgent,
    stats,
    [Symbol.asyncDispose]: disposeSystem,
  };
};
