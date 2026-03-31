import type { DatabaseSync } from "node:sqlite";
import { EventDraft, eventMatches, type Event } from "../lib/event.ts";
import { pullNextMatchingEvent, pushEvent } from "../event-queue.ts";
import { abortableSleep } from "../lib/promise.ts";
import { dispose } from "../lib/dispose.ts";
import { loggerOf } from "../lib/json-logger.ts";

const logger = loggerOf({ source: "agent-system.ts" });

export type AgentHandler = {
  listen: string[];
  ignoreSelf: boolean;
  stream: (event: Event) => ReadableStream<EventDraft>;
  disposed: AbortSignal;
  [Symbol.asyncDispose](): Promise<void>;
};

export type AgentSystem = {
  spawn: (id: string, create: () => AgentHandler) => string;
  kill: (id: string) => Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

export const agentSystemOf = (
  db: DatabaseSync,
  timeout = 1000,
): AgentSystem => {
  logger.debug("Agent system created");
  const systemAbortController = new AbortController();

  const handlers: Map<string, AgentHandler> = new Map();

  const forkAgentPollLoop = async (id: string, agent: AgentHandler): Promise<void> => {
    // If either the agent or the system is disposed, abort the loop
    const signal = AbortSignal.any([agent.disposed, systemAbortController.signal]);

    const shouldHandleEvent = (event: Event) => {
      if (agent.ignoreSelf && event.agent_id === id) {
        return false;
      }
      return eventMatches(event, agent.listen);
    };

    try {
      while (!signal.aborted) {
        const event = pullNextMatchingEvent(db, id, shouldHandleEvent);

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
          pushEvent(db, id, draft.type, draft.payload);
        }
      }
    } catch (e) {
      logger.warn("Agent poll loop error", { error: `${e}` });
    } finally {
      await dispose(agent);
    }
  };

  const spawn = (id: string, create: () => AgentHandler) => {
    systemAbortController.signal.throwIfAborted();
    if (handlers.has(id)) {
      throw new Error(`Agent with id ${id} already registered`);
    }
    logger.debug("Spawning agent", { id });

    const agent = create();
    forkAgentPollLoop(id, agent);

    handlers.set(id, agent);

    return id;
  };

  const kill = async (id: string): Promise<void> => {
    const agent = handlers.get(id);
    if (!agent) {
      return;
    }
    await dispose(agent);
    handlers.delete(id);
  };

  const disposeSystem = async (): Promise<void> => {
    if (systemAbortController.signal.aborted) {
      return;
    }
    systemAbortController.abort(new Error("System stopped"));
    const kills = Array.from(handlers.keys()).map(kill);
    await Promise.allSettled(kills);
    handlers.clear();
  };

  return {
    spawn,
    kill,
    [Symbol.asyncDispose]: disposeSystem,
  };
};
