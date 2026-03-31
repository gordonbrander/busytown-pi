import type { Event, EventDraft } from "../lib/event.ts";
import type { Agent } from "./agent.ts";

export type MockAgentOpts = {
  id: string;
  listen?: string[];
  ignoreSelf?: boolean;
  onEvent?: (event: Event) => EventDraft[];
};

export type MockAgent = Agent & {
  received: Event[];
};

export const mockAgentOf = (opts: MockAgentOpts): MockAgent => {
  const abortController = new AbortController();
  const received: Event[] = [];

  return {
    id: opts.id,
    listen: opts.listen ?? ["*"],
    ignoreSelf: opts.ignoreSelf ?? true,
    received,

    stream(event: Event): ReadableStream<EventDraft> {
      abortController.signal.throwIfAborted();
      received.push(event);
      const drafts = opts.onEvent?.(event) ?? [];
      return new ReadableStream({
        start(controller) {
          for (const draft of drafts) {
            controller.enqueue(draft);
          }
          controller.close();
        },
      });
    },

    disposed: abortController.signal,

    async [Symbol.asyncDispose](): Promise<void> {
      if (!abortController.signal.aborted) {
        abortController.abort(new Error("Mock agent disposed"));
      }
    },
  };
};
