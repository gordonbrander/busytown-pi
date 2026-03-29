import type { DatabaseSync } from "node:sqlite";
import type { Event } from "../lib/event.ts";
import { eventMatches } from "../lib/event.ts";
import {
  pullNextMatchingEvent,
  pushEvent,
} from "../event-queue.ts";
import { abortableSleep } from "../lib/promise.ts";
import { type AgentProcess } from "./types.ts";
import { isFinishedResponseEvent } from "./events.ts";

export type AgentSystem = {
  spawn: (def: AgentDef) => string;
  kill: (id: string) => Promise<boolean>;
  stop: () => Promise<void>;
};

export type AgentDef = {
  id: string;
  listen: string[];
  ignoreSelf: boolean;
  create: () => AgentProcess;
};

export type AgentHandle = {
  eventLoop: Promise<void>;
  abortController: AbortController;
};

export const agentSystemOf = (
  db: DatabaseSync,
  timeout = 1000,
): AgentSystem => {
  const systemAbortController = new AbortController();

  const agentHandles: Map<string, AgentHandle> = new Map();

  const forkAgentEventLoop = async (agent: AgentDef, signal: AbortSignal) => {
    const shouldHandleEvent = (event: Event) => {
      if (agent.ignoreSelf && event.agent_id === agent.id) {
        return false;
      }
      return eventMatches(event, agent.listen);
    };

    const proc = agent.create();

    try {
      while (!signal.aborted) {
        const event = pullNextMatchingEvent(db, agent.id, shouldHandleEvent);

        if (!event) {
          await abortableSleep(timeout, signal);
          continue;
        }

        for await (const res of proc.stream(event, { signal })) {
          if (isFinishedResponseEvent(res)) {
            pushEvent(db, agent.id, `agent.${agent.id}.stream`, res);
          }
        }
      }
    } finally {
      await proc.kill();
    }
  };

  const spawn = (def: AgentDef) => {
    systemAbortController.signal.throwIfAborted();

    if (agentHandles.has(def.id)) {
      throw new Error(`Agent with id ${def.id} already registered`);
    }

    const agentAbortController = new AbortController();
    const eventLoopAbortSignal = AbortSignal.any([
      agentAbortController.signal,
      systemAbortController.signal
    ]);

    agentHandles.set(def.id, {
      eventLoop: forkAgentEventLoop(def, eventLoopAbortSignal),
      abortController: agentAbortController,
    });

    return def.id;
  };

  const kill = async (id: string): Promise<boolean> => {
    const handle = agentHandles.get(id);
    if (!handle) {
      return false;
    }
    handle.abortController.abort(new Error(`Agent killed`));
    await handle.eventLoop;
    agentHandles.delete(id);
    return true;
  };

  const stop = async () => {
    if (systemAbortController.signal.aborted) {
      return;
    }
    systemAbortController.abort(new Error("System stopped"));
    const kills = Array.from(agentHandles.keys()).map(kill);
    await Promise.allSettled(kills);
    agentHandles.clear();
  };

  return {
    spawn,
    kill,
    stop
  }
}
