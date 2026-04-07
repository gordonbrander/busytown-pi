import type { Event } from "./lib/event.ts";
import type { AgentSetup, HandleOptions, SendFn } from "./agent.ts";

export type AgentHandler = (
  send: SendFn,
  event: Event,
  options?: HandleOptions,
) => void | Promise<void>;

export const virtualAgentOf =
  (handler: AgentHandler): AgentSetup =>
  async (_id, send) => {
    let disposed = false;
    return {
      async handle(event, options) {
        if (disposed) throw new Error("Agent is disposed");
        await handler(send, event, options);
      },
      async [Symbol.asyncDispose]() {
        disposed = true;
      },
    };
  };
