import type { ModelResponse } from "./model.ts";

/**
 * High-level model stream events emitted by `ChatModel.stream`
 * (from Di baseline `Core/Llm/IChatModel.cs` `ModelEvent`).
 *
 * The low-level provider chunk vocabulary (`ProviderChunk`, `ProviderBlockStart`)
 * is added in the P3 stream-assembler unit per architecture.md; it never leaks
 * to the loop. `completed` is emitted exactly once per model call and carries
 * the full assembled {@link ModelResponse}.
 */
export type ModelEvent =
  | { readonly type: "textDelta"; readonly delta: string }
  | { readonly type: "reasoningDelta"; readonly delta: string }
  | { readonly type: "toolCallDelta"; readonly id: string; readonly name: string; readonly arguments: string }
  | { readonly type: "completed"; readonly response: ModelResponse };
