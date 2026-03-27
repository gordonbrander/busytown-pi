export type AgentRunEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "text_delta";            delta: string }
  | { type: "text_end";              content: string }
  | { type: "thinking_delta";        delta: string }
  | { type: "thinking_end";          content: string }
  | { type: "tool_execution_start";  toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; partialResult: unknown }
  | { type: "tool_execution_end";    toolCallId: string; isError: boolean; result: unknown }
  | { type: "turn_end" }
  | { type: "agent_end" }

export type AgentProcess = {
  /** Stable identifier for this agent process. Matches the agent's configured ID. */
  readonly id: string

  /**
   * Persistent stream of events for all agent runs, in order.
   * Remains open for the lifetime of the process.
   */
  readonly output: ReadableStream<AgentRunEvent>

  /**
   * Sends a message to the agent. Resolves when the agent run is complete
   * (after `agent_end` is emitted). This is the backpressure mechanism —
   * callers should await before sending the next message.
   *
   * Passing an AbortSignal cancels the in-flight run without tearing down
   * the process. The output stream still emits `agent_end` after cancellation
   * and the promise resolves normally.
   */
  send(message: string, abort?: AbortSignal): Promise<void>

  /**
   * Shuts down the agent process entirely and closes the output stream.
   * Permanent teardown — distinct from per-run abort.
   */
  dispose(): Promise<void>
}
