import type { Event } from "./lib/event.ts";
import type { AgentSetup, SendFn } from "./agent.ts";

export type MockAgent = {
  received: Event[];
  setup: AgentSetup;
};

export const mockAgentOf = (
  onEvent?: (send: SendFn, event: Event) => void | Promise<void>,
): MockAgent => {
  const received: Event[] = [];

  const setup: AgentSetup = async (_id, send) => {
    let disposed = false;
    return {
      async handle(event) {
        if (disposed) throw new Error("Mock agent disposed");
        received.push(event);
        await onEvent?.(send, event);
      },
      async [Symbol.asyncDispose]() {
        disposed = true;
      },
    };
  };

  return { received, setup };
};
