import type { Event } from "./lib/event.ts";
import {
  getOrOpenDb,
  getOrCreateCursor,
  pullNextMatchingEvent,
  pushEvent,
  claimEvent,
} from "./event-queue.ts";
import { shouldHandleEventOf } from "./lib/event.ts";
import { abortableSleep } from "./lib/promise.ts";
import { neverAbortSignal } from "./lib/abort-controller.ts";
import { loggerOf } from "./lib/json-logger.ts";
export { loggerOf };

/** Configuration for creating an event client. */
export type ClientConfig = {
  /** Agent identifier. Used for cursor tracking and as agent_id on published events. */
  id: string;
  /** Path to the SQLite database file. */
  dbPath: string;
  /**
   * If set, `subscribe()` throws `OrphanedError` when `process.ppid` no longer
   * matches this value — i.e. the parent process died and this subprocess was
   * reparented. Leave unset for standalone agents.
   */
  parentPid?: number;
};

/**
 * Throws if `getPpid()` no longer matches `parentPid` — i.e. the subprocess
 * was reparented because its parent died. `getPpid` is injectable for tests.
 */
export const throwIfOrphaned = (
  parentPid: number,
  getPpid: () => number = () => process.ppid,
): void => {
  const current = getPpid();
  if (current !== parentPid) {
    throw new Error(
      `Process was orphaned: expected parent pid ${parentPid}, got ${current}`,
    );
  }
};

export type ListenConfig = {
  /** Event type patterns to subscribe to. Supports exact match, glob ("prefix.*"), and wildcard ("*"). */
  listen: string[];
  /** If true, skip events published by this agent. Default: true. */
  ignoreSelf?: boolean;
  /** Poll interval in milliseconds. Default: 1000. */
  pollInterval?: number;
  /** Signal to stop the subscribe loop. */
  signal?: AbortSignal;
  /**
   * If true, atomically claim each event before yielding. Only events this
   * agent successfully claims are yielded; events claimed by other agents are
   * skipped (the cursor still advances past them). Default: false.
   */
  claim?: boolean;
};

/** The client returned by `clientOf()`. */
export type EventClient = {
  /**
   * Push an event to the queue. If `cause` is provided, the new event
   * inherits its `correlation_id` (or the cause's own id if it's a root)
   * and sets `causation_id` to `cause.id`, with `depth = cause.depth + 1`.
   */
  publish: (type: string, payload?: unknown, cause?: Event) => Event;
  /** Claim exclusive ownership of an event. Returns true if claimed. */
  claim: (eventId: number, cause?: Event) => boolean;
  /** Async iterable that polls for matching events. Advances cursor after each yield. */
  subscribe: (config: ListenConfig) => AsyncIterable<Event>;
};

const clientLogger = loggerOf({ source: "sdk.ts", feature: "client" });

/** Factory that creates an event client with bound publish/claim/subscribe. */
export const clientOf = ({
  id,
  dbPath,
  parentPid,
}: ClientConfig): EventClient => {
  clientLogger.debug(`Client initialized`, {
    id,
    dbPath,
    parentPid,
  });
  const db = getOrOpenDb(dbPath);
  getOrCreateCursor(db, id);

  async function* subscribe({
    listen,
    ignoreSelf = true,
    pollInterval = 1000,
    signal = neverAbortSignal,
    claim = false,
  }: ListenConfig): AsyncGenerator<Event> {
    clientLogger.debug(`subscribe`, {
      id,
      dbPath,
      listen,
      ignoreSelf,
      pollInterval,
      claim,
    });
    const shouldHandle = shouldHandleEventOf(id, ignoreSelf, listen);
    while (!signal.aborted) {
      if (parentPid !== undefined) throwIfOrphaned(parentPid);
      const event = pullNextMatchingEvent(db, id, shouldHandle, claim);
      if (event) {
        yield event;
      } else {
        await abortableSleep(pollInterval, signal);
      }
    }
  }

  const publish = (type: string, payload: unknown = {}, cause?: Event): Event =>
    pushEvent(db, id, type, payload, cause);

  const claim = (eventId: number, cause?: Event): boolean =>
    claimEvent(db, id, eventId, cause);

  return {
    publish,
    claim,
    subscribe,
  };
};
