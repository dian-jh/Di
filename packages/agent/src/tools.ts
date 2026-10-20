import type { ToolCall } from "@di/ai";

/**
 * Tool-calling vocabulary (from Di baseline `Core/AgentLoop/IToolExecutor.cs`
 * + docs/migration/typescript-core/loop-and-state.md §"建议公开的最小 loop types").
 *
 * Executors/validators belong to @di/agent; the model-facing `ToolSpec` and the
 * `ToolCall` content block are imported from @di/ai to avoid dependency inversion.
 * The loop turns executor exceptions into error observations rather than crashing.
 */

/** Result of one tool execution, fed back to the model as the observation text. */
export interface ToolObservation {
  readonly text: string;
  readonly isError: boolean;
}

/** Executes one (already validated) tool call. */
export interface ToolExecutor {
  execute(call: ToolCall, signal?: AbortSignal): Promise<ToolObservation>;
}

/** Validation seam (security/permission); reject a call by throwing. Optional in MVP. */
export interface ToolValidator {
  validate(call: ToolCall, signal?: AbortSignal): void | Promise<void>;
}
