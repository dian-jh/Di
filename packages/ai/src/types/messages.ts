import type { ContentBlock } from "./content.ts";
import { isTextBlock } from "./content.ts";

/*
 * Normalized message vocabulary.
 *
 * This is the harness trajectory unit, the session log unit and the shared
 * plugin vocabulary; adapters alone translate provider wire formats to/from it.
 */

/** System message. */
export interface SystemMessage {
  readonly role: "system";
  readonly text: string;
}

/** User message: a sequence of content blocks (text / image / file). */
export interface UserMessage {
  readonly role: "user";
  readonly content: readonly ContentBlock[];
}

/** Assistant message: text + reasoning + tool-call blocks. */
export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly ContentBlock[];
}

/** Tool result message answering one tool call (a member of the message union). */
export interface ToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly content: string;
  readonly isError: boolean;
}

export type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

/** Visible text of a message, reasoning excluded (from `ChatMessageExtensions.GetText`). */
export function textOfMessage(message: AgentMessage): string {
  switch (message.role) {
    case "system":
      return message.text;
    case "user":
      return message.content.filter(isTextBlock).map((block) => block.text).join("");
    case "assistant":
      return message.content.filter(isTextBlock).map((block) => block.text).join("");
    case "tool":
      return message.content;
  }
}
