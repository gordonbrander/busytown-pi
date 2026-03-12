import type { DatabaseSync } from "node:sqlite";
import type { Event } from "./lib/event.ts";
import { eventMatches } from "./lib/event.ts";
import {
  getNextEvent,
  getOrCreateCursor,
  pushEvent,
  updateCursor,
} from "./event-queue.ts";
import { abortableSleep, nextTick } from "./lib/promise.ts";
import { memoize } from "./lib/memoize.ts";
import { type Result } from "./lib/result.ts";
import { logger } from "./lib/json-logger.ts";

export type EffectContext = {
  abortSignal: AbortSignal;
};

export type Effect = (event: Event, context: EffectContext) => Promise<void>;

export type Agent = {
  id: string;
  listen: string[];
  hidden: boolean;
  ignoreSelf: boolean;
  run: Effect;
};

export type AgentHandle = {
  agent: Agent;
  fork: Promise<void>;
  abortController: AbortController;
};

export type AgentSystem = {
  spawn: (agent: Agent) => string;
  kill: (id: string) => Promise<boolean>;
  stop: () => Promise<void>;
};

export const agent = (opts: {
  id: string;
  listen: string[];
  hidden?: boolean;
  ignoreSelf?: boolean;
  run: Effect;
}): Agent => ({
  id: opts.id,
  listen: opts.listen,
  hidden: opts.hidden ?? false,
  ignoreSelf: opts.ignoreSelf ?? true,
  run: opts.run,
});

export const createAgentSystem = (
  db: DatabaseSync,
  timeout = 1000,
): AgentSystem => {
  const agents = new Map<string, AgentHandle>();
  const runningEffects = new Set<Promise<Result<void, string>>>();
  let systemAbortController = new AbortController();

  const runEffect = async (
    agent: Agent,
    event: Event,
    abortSignal: AbortSignal,
  ): Promise<Result<void, string>> => {
    if (abortSignal.aborted) {
      return { ok: false, error: `Agent aborted: ${agent.id}` };
    }
    try {
      await agent.run(event, { abortSignal });
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: `${error}` };
    }
  };

  const manageEffect = async (
    a: Agent,
    event: Event,
    abortSignal: AbortSignal,
  ): Promise<void> => {
    if (!a.hidden) {
      pushEvent(db, a.id, `sys.agent.${a.id}.start`, {
        event_id: event.id,
        event_type: event.type,
        agent_listen: a.listen,
      });
    }

    const effectResultPromise = runEffect(a, event, abortSignal);
    runningEffects.add(effectResultPromise);

    const res = await effectResultPromise;
    runningEffects.delete(effectResultPromise);

    if (!a.hidden) {
      if (!res.ok) {
        pushEvent(db, a.id, `sys.agent.${a.id}.error`, {
          event_id: event.id,
          error: res.error,
        });
      } else {
        pushEvent(db, a.id, `sys.agent.${a.id}.finish`, {
          event_id: event.id,
        });
      }
    }
  };

  const forkAgent = async (
    a: Agent,
    abortSignal: AbortSignal,
  ): Promise<void> => {
    while (!abortSignal.aborted) {
      const sinceId = getOrCreateCursor(db, a.id);
      const event = getNextEvent(db, sinceId);

      if (!event) {
        await abortableSleep(timeout, abortSignal);
        continue;
      }

      // Advance cursor before processing (at-most-once delivery)
      updateCursor(db, a.id, event.id);

      if (a.ignoreSelf && event.agent_id === a.id) {
        await nextTick();
        continue;
      }

      if (eventMatches(event, a.listen)) {
        await manageEffect(a, event, abortSignal);
      }

      await nextTick();
    }
  };

  const spawn = (a: Agent): string => {
    if (agents.has(a.id)) {
      throw new Error(`Agent "${a.id}" already exists`);
    }

    const abortController = new AbortController();
    const signal = AbortSignal.any([
      abortController.signal,
      systemAbortController.signal,
    ]);

    const fork = forkAgent(a, signal);
    agents.set(a.id, { agent: a, fork, abortController });
    return a.id;
  };

  const kill = async (id: string): Promise<boolean> => {
    const handle = agents.get(id);
    if (!handle) return false;
    handle.abortController.abort();
    await handle.fork;
    agents.delete(id);
    logger.info("Agent killed", { id });
    return true;
  };

  const stop = async (): Promise<void> => {
    systemAbortController.abort();
    await Promise.all([...agents.values()].map((h) => h.fork));
    await Promise.all([...runningEffects]);
    agents.clear();
    systemAbortController = new AbortController();
  };

  return { spawn, kill, stop };
};

/** Get or create a system by key */
export const getOrCreateAgentSystem = memoize(
  (_key: string, db: DatabaseSync, timeout: number = 1000): AgentSystem =>
    createAgentSystem(db, timeout),
  (key, _db, _timeout) => key,
);
