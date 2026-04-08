import type { Event } from "./lib/event.ts";
import type { AgentSetup, HandleOptions, SendFn } from "./agent.ts";

export type AgentHandler = (
  send: SendFn,
  event: Event,
  options: HandleOptions,
) => void | Promise<void>;

const neverAbortSignal = new AbortController().signal;

export const virtualAgentOf =
  (handler: AgentHandler): AgentSetup =>
  async (_id, send) => {
    const disposedController = new AbortController();

    const handle = async (
      event: Event,
      { signal: abortHandleSignal = neverAbortSignal }: HandleOptions = {},
    ): Promise<void> => {
      if (disposedController.signal.aborted)
        throw new Error("Agent is disposed");
      const abortSignal = AbortSignal.any([
        disposedController.signal,
        abortHandleSignal,
      ]);
      await handler(send, event, { signal: abortSignal });
    };

    const dispose = async (): Promise<void> => {
      disposedController.abort(new Error("Abort virtual-agent"));
    };

    return {
      handle,
      [Symbol.asyncDispose]: dispose,
    };
  };
