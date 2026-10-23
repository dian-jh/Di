import type { ToolObservation } from "@di/agent";
import type { ToolSpec } from "@di/ai";

/*
 * One built-in core tool.
 *
 * the: a model-facing definition
 * (`ToolSpec` from `@di/ai`) is co-located with its execution function
 * (architecture.md §模块映射: "tool schema 随工具实现共置"), plus the prompt
 * snippet/guidelines the tool contributes to the system prompt.
 *
 * `execute` receives the raw JSON text the model produced for `arguments`
 * (`ICoreTool.ExecuteAsync(string argumentsJson,...)`). Expected failures
 * return an observation whose `text` starts with "error: " — never thrown to the
 * loop. Hard cancellation propagates as an AbortError rejection, which the loop
 * must not convert into a plain error observation (loop-and-state.md).
 */
export interface CoreTool {
  /** Model-facing definition (name / description / JSON-Schema parameters). */
  readonly spec: ToolSpec;

  /** One-line "what it does" for the system prompt (`ICoreTool.PromptSnippet`). */
  readonly promptSnippet: string;

  /** Imperative operation rules contributed to the system prompt (`PromptGuidelines`). */
  readonly promptGuidelines: readonly string[];

  /** Execute one tool call with raw JSON arguments; always resolves to an observation. */
  execute(argumentsJson: string, signal?: AbortSignal): Promise<ToolObservation>;
}

/** Success observation for the loop. */
export function okObservation(text: string): ToolObservation {
  return { text, isError: false };
}

/** Expected-failure observation (text starts with "error: ", per the tool contract). */
export function errorObservation(text: string): ToolObservation {
  return { text, isError: true };
}
