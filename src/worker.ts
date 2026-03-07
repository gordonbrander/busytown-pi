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

export type EffectContext = {
  abortSignal: AbortSignal;
};

export type Effect = (event: Event, context: EffectContext) => Promise<void>;

export type Worker = {
  id: string;
  listen: string[];
  hidden: boolean;
  ignoreSelf: boolean;
  run: Effect;
};

export type WorkerHandle = {
  worker: Worker;
  fork: Promise<void>;
  abortController: AbortController;
};

export type WorkerSystem = {
  spawn: (worker: Worker) => string;
  kill: (id: string) => Promise<boolean>;
  stop: () => Promise<void>;
};

export const worker = (opts: {
  id: string;
  listen: string[];
  hidden?: boolean;
  ignoreSelf?: boolean;
  run: Effect;
}): Worker => ({
  id: opts.id,
  listen: opts.listen,
  hidden: opts.hidden ?? false,
  ignoreSelf: opts.ignoreSelf ?? true,
  run: opts.run,
});

export const createSystem = (
  db: DatabaseSync,
  timeout = 1000,
): WorkerSystem => {
  const workers = new Map<string, WorkerHandle>();
  const runningEffects = new Set<Promise<void>>();
  const systemAbortController = new AbortController();

  const manageEffect = async (
    w: Worker,
    event: Event,
    abortSignal: AbortSignal,
  ): Promise<void> => {
    if (!w.hidden) {
      pushEvent(db, w.id, `sys.worker.${w.id}.start`, {
        event_id: event.id,
        event_type: event.type,
        worker_listen: w.listen,
      });
    }

    const effectPromise = (async () => {
      try {
        await w.run(event, { abortSignal });
        if (!w.hidden) {
          pushEvent(db, w.id, `sys.worker.${w.id}.finish`, {
            event_id: event.id,
          });
        }
      } catch (err) {
        if (!w.hidden) {
          pushEvent(db, w.id, `sys.worker.${w.id}.error`, {
            event_id: event.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    runningEffects.add(effectPromise);
    effectPromise.finally(() => runningEffects.delete(effectPromise));
    await effectPromise;
  };

  const forkWorker = async (
    w: Worker,
    abortSignal: AbortSignal,
  ): Promise<void> => {
    while (!abortSignal.aborted) {
      const sinceId = getOrCreateCursor(db, w.id);
      const event = getNextEvent(db, sinceId);

      if (!event) {
        await abortableSleep(timeout, abortSignal);
        continue;
      }

      // Advance cursor before processing (at-most-once delivery)
      updateCursor(db, w.id, event.id);

      if (w.ignoreSelf && event.worker_id === w.id) {
        await nextTick();
        continue;
      }

      if (eventMatches(event, w.listen)) {
        await manageEffect(w, event, abortSignal);
      }

      await nextTick();
    }
  };

  const spawn = (w: Worker): string => {
    if (workers.has(w.id)) {
      throw new Error(`Worker "${w.id}" already exists`);
    }

    const abortController = new AbortController();
    const signal = AbortSignal.any([
      abortController.signal,
      systemAbortController.signal,
    ]);

    const fork = forkWorker(w, signal);
    workers.set(w.id, { worker: w, fork, abortController });
    return w.id;
  };

  const kill = async (id: string): Promise<boolean> => {
    const handle = workers.get(id);
    if (!handle) return false;
    handle.abortController.abort();
    await handle.fork;
    workers.delete(id);
    return true;
  };

  const stop = async (): Promise<void> => {
    systemAbortController.abort();
    await Promise.all([...workers.values()].map((h) => h.fork));
    await Promise.all([...runningEffects]);
    workers.clear();
  };

  return { spawn, kill, stop };
};

/** Get or create a system by key */
export const getOrCreateSystem = memoize(
  (_key: string, db: DatabaseSync, timeout: number = 1000): WorkerSystem =>
    createSystem(db, timeout),
  (key, _db, _timeout) => key,
);
