import type { RequestEvent, ResponseEvent } from "./events.ts";

/**
 * A stable handle to an agent for the lifetime of that agent. The underlying
 * OS process may be long-lived (Pi RPC) or spawned per-send (Claude CLI,
 * shell) — that is an implementation detail.
 *
 * `stream()` returns an `ReadableStream` that yields all response events for a
 * single agent run, completing when the run is done (`agent_end`). Callers
 * consume via `for-await-of`, which provides natural backpressure. Only one
 * `stream()` may be active at a time.
 */
export type SendOptions = {
  signal?: AbortSignal;
};

export type AgentProcess = {
  stream(
    request: RequestEvent,
    options?: SendOptions,
  ): ReadableStream<ResponseEvent>;
  aborted: AbortSignal;
  kill(): Promise<void>;
};
