import type { EventClient } from "../sdk.ts";
import type { AgentDef } from "./file-agent-loader.ts";

export type AgentHandlerExtra = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  pollInterval?: number;
  /** Signal to stop the handler's subscribe loop. */
  signal?: AbortSignal;
  /** Pi CLI extensions to load. Set by file-agent when building pi handlers. */
  extensions?: string[];
  /** System prompt appended to Pi CLI. Set by file-agent when building pi handlers. */
  system?: string;
};

/** An agent handler. Runs the subscribe loop and processes events. */
export type AgentHandler = (
  client: EventClient,
  config: AgentDef & AgentHandlerExtra,
) => Promise<void>;
