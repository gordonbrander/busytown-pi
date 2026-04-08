import type { Event } from "./lib/event.ts";

export type HandleOptions = {
  signal?: AbortSignal;
};

/**
 * An agent that handles events effectfully.
 * The agent receives a `send` function at construction time, allowing it to
 * emit events at any point in its lifecycle.
 */
export type Agent = {
  /**
   * Effectful event handler.
   * Promise signals when effects are complete. This can be used for
   * backpressure.
   */
  handle(event: Event, options?: HandleOptions): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

/** Push an event to the queue */
export type SendFn = (type: string, payload: unknown) => Promise<void>;

/**
 * Agent setup function. Receives the agent's id and a `send` function,
 * and returns an agent. This allows agents to emit events during
 * construction, and to know their own id for lifecycle events.
 */
export type AgentSetup = (id: string, send: SendFn) => Promise<Agent>;

export type SpawnAgentConfig = {
  id: string;
  listen: string[];
  ignoreSelf?: boolean;
  setup: AgentSetup;
};
