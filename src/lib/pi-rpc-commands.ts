import type { AgentSessionEvent as PiAgentSessionEvent } from "@mariozechner/pi-coding-agent";

/**
 * A Pi RPC `prompt` command — what gets written to the Pi process stdin to
 * start an agent run.
 */
export type PromptCommand = { type: "prompt"; message: string };
export type AbortCommand = { type: "abort" };
export type CompactCommand = { type: "compact" };
export type NewSessionCommand = { type: "new_session" };
export type PiRpcCommand =
  | PromptCommand
  | AbortCommand
  | CompactCommand
  | NewSessionCommand;

/**
 * A synchronous RPC response to a command we sent. The full `RpcResponse`
 * type isn't exported from `@mariozechner/pi-coding-agent`, so we describe
 * just the discriminator + the fields we read.
 */
export type PiRpcResponse = {
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
};

/**
 * A line emitted on Pi RPC stdout — either a streamed session event or a
 * synchronous RPC response.
 */
export type PiRpcStdoutLine = PiAgentSessionEvent | PiRpcResponse;

export const isPiRpcResponse = (line: PiRpcStdoutLine): line is PiRpcResponse =>
  line.type === "response";
