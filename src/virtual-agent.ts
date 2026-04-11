import type { Event } from "./lib/event.ts";
import type { EventClient } from "./sdk.ts";
import type { AgentHandler } from "./agent-handler.ts";

/** Wrap a simple event callback as a full AgentHandler with its own subscribe loop. */
export const virtualAgentHandler =
  (
    handler: (client: EventClient, event: Event) => void | Promise<void>,
  ): AgentHandler =>
  async (client, config) => {
    const { listen, ignoreSelf, pollInterval, signal } = config;
    for await (const event of client.subscribe({ listen, ignoreSelf, pollInterval, signal })) {
      await handler(client, event);
    }
  };
