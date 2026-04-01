import type { Event, EventDraft } from "./lib/event.ts";

/**
 * An agent process
 * Underlying implementation may be short lived or long-lived.
 */
export type AgentProcess = {
  /**
   * Send an event and stream responses from the agent.
   * Stream represents the responses for a single agent cycle, e.g.:
   * ```
   * user message -> (response -> tool call -> tool result -> response... -> final response)
   * ```
   * @throws {Error} if called after the disposed signal has been aborted.
   * @returns a readable stream of event drafts.
   */
  stream(event: Event): ReadableStream<EventDraft>;

  /**
   * Signals when the process is disposed.
   * Implementors should abort the signal immediately when `agent.dispose()` is
   * called, and not wait for disposal completion.
   * Other methods such as `stream()` should throw an error when called after
   * the disposed signal has been aborted.
   */
  disposed: AbortSignal;

  /**
   * Teardown and clean up any internal long-lived resources.
   * Implementors should make this method idempotent.
   * Calling this should also cause the `disposed` AbortSignal to be aborted.
   * @returns promise for the completion of the teardown.
   */
  [Symbol.asyncDispose](): Promise<void>;
};

export type Agent = AgentProcess & {
  id: string;
  listen: string[];
  ignoreSelf: boolean;
};
