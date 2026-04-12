import type { Event } from "./lib/event.ts";
import {
  getOrOpenDb,
  getOrCreateCursor,
  pullNextMatchingEvent,
  pushEvent,
  claimEvent,
} from "./event-queue.ts";
import { eventMatches } from "./lib/event.ts";
import { abortableSleep } from "./lib/promise.ts";
export { loggerOf } from "./lib/json-logger.ts";

/** Create a predicate function that checks if agent should handle event. */
export const shouldHandleEventOf =
  (id: string, ignoreSelf: boolean, listen: string[]) =>
  (event: Event): boolean => {
    if (ignoreSelf && event.agent_id === id) {
      return false;
    }
    return eventMatches(event, listen);
  };

/** Configuration for creating an event client. */
export type ClientConfig = {
  /** Agent identifier. Used for cursor tracking and as agent_id on published events. */
  id: string;
  /** Path to the SQLite database file. */
  dbPath: string;
};

/** A signal that will never abort. */
const neverAbortSignal = new AbortController().signal;

export type ListenConfig = {
  /** Event type patterns to subscribe to. Supports exact match, glob ("prefix.*"), and wildcard ("*"). */
  listen: string[];
  /** If true, skip events published by this agent. Default: true. */
  ignoreSelf?: boolean;
  /** Poll interval in milliseconds. Default: 1000. */
  pollInterval?: number;
  /** Signal to stop the subscribe loop. */
  signal?: AbortSignal;
};

/** The client returned by `clientOf()`. */
export type EventClient = {
  /** Push an event to the queue. */
  publish: (type: string, payload?: unknown) => Event;
  /** Claim exclusive ownership of an event. Returns true if claimed. */
  claim: (eventId: number) => boolean;
  /** Async iterable that polls for matching events. Advances cursor after each yield. */
  subscribe: (config: ListenConfig) => AsyncIterable<Event>;
};

/** Factory that creates an event client with bound publish/claim/subscribe. */
export const clientOf = ({ id, dbPath }: ClientConfig): EventClient => {
  const db = getOrOpenDb(dbPath);
  getOrCreateCursor(db, id);

  async function* subscribe({
    listen,
    ignoreSelf = true,
    pollInterval = 1000,
    signal = neverAbortSignal,
  }: ListenConfig): AsyncGenerator<Event> {
    const shouldHandle = shouldHandleEventOf(id, ignoreSelf, listen);
    while (!signal.aborted) {
      const event = pullNextMatchingEvent(db, id, shouldHandle);
      if (event) {
        yield event;
      } else {
        await abortableSleep(pollInterval, signal);
      }
    }
  }

  const publish = (type: string, payload: unknown = {}): Event =>
    pushEvent(db, id, type, payload);

  const claim = (eventId: number): boolean => claimEvent(db, id, eventId);

  return {
    publish,
    claim,
    subscribe,
  };
};
