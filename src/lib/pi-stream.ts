import type {
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
} from "@mariozechner/pi-ai";

export type { UserMessage, AssistantMessage, ToolResultMessage };
export type PiMessage = UserMessage | AssistantMessage | ToolResultMessage;

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
