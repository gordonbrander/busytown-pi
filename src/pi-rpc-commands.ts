/**
 * A Pi RPC `prompt` command — what gets written to the Pi process stdin to
 * start an agent run.
 */
export type PromptCommand = { type: "prompt"; message: string };
export type AbortCommand = { type: "abort" };
export type CompactCommand = { type: "compact" };
export type PiRpcCommand = PromptCommand | AbortCommand | CompactCommand;
