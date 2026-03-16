import type {
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
} from "@mariozechner/pi-agent-core";

export type PiMessage = UserMessage | AssistantMessage | ToolResultMessage;

/** Parses a jsonl line and returns a PiMessage or undefined, if we're not interested in the value */
export const parsePiLine = (line: string): PiMessage | undefined => {
  try {
    const event = JSON.parse(line);
    if (event.type === "message_end")
      return event.message as UserMessage | AssistantMessage;
    if (event.type === "tool_execution_end")
      return event.result as ToolResultMessage;
    return undefined;
  } catch {
    return undefined;
  }
};
