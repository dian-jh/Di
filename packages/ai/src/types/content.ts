/*
 * Message content blocks.
 *
 * In-memory vocabulary only. Provider wire DTOs never leak into this union;
 * adapters translate wire formats to/from these blocks. Unknown block types are
 * preserved losslessly via {@link OpaqueBlock} — never dropped.
 */

/** Plain text. */
export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

/** Reasoning/thinking content, kept separate from visible text. */
export interface ReasoningBlock {
  readonly type: "reasoning";
  readonly text: string;
}

/** Image reference (durable attachment id). */
export interface ImageBlock {
  readonly type: "image";
  readonly attachmentId: string;
  readonly detail?: string;
}

/** File reference (durable attachment id). */
export interface FileBlock {
  readonly type: "file";
  readonly attachmentId: string;
  readonly filename?: string;
}

/** A model tool call. `arguments` is raw JSON text; never parsed or reshaped by the model layer. */
export interface ToolCall {
  readonly type: "tool-call";
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** Tool execution result, fed back to the model. */
export interface ToolResultBlock {
  readonly type: "tool-result";
  readonly toolCallId: string;
  readonly content: string;
  readonly isError: boolean;
}

/** Escape hatch for unknown block types contributed by plugins: preserved losslessly. */
export interface OpaqueBlock {
  readonly type: string & {};
  readonly rawJson: string;
}

export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ImageBlock
  | FileBlock
  | ToolCall
  | ToolResultBlock
  | OpaqueBlock;

export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === "text";
}
