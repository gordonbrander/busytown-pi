import type { Agent } from "./agent.ts";
import type { Event } from "./lib/event.ts";
import type { EventDraft } from "./lib/event.ts";
import { parseSlug } from "./lib/slug.ts";
import { emptyReadableStream } from "./lib/web-stream.ts";

export type VirtualAgentHandler = (event: Event) => void | Promise<void>;

export type VirtualAgentConfig = {
  id: string;
  listen: string[];
  ignoreSelf?: boolean;
  handler: VirtualAgentHandler;
};

export const virtualAgentOf = (config: VirtualAgentConfig): Agent => {
  const { listen, ignoreSelf = true, handler } = config;
  const id = parseSlug(config.id);
  const abortController = new AbortController();

  const stream = (event: Event): ReadableStream<EventDraft> => {
    abortController.signal.throwIfAborted();
    handler(event);
    return emptyReadableStream();
  };

  const asyncDispose = async (): Promise<void> => {
    if (abortController.signal.aborted) return;
    abortController.abort(new Error("Virtual agent disposed"));
  };

  return {
    id,
    listen,
    ignoreSelf,
    stream,
    disposed: abortController.signal,
    [Symbol.asyncDispose]: asyncDispose,
  };
};
