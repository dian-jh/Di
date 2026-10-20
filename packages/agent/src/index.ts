/**
 * @di/agent — pure ReAct loop vocabulary.
 *
 * P2.1 + P2.2 status: the loop-owned types (AgentResult, AgentEvent,
 * AgentDependencies, LoopCheckpoint, StopReason), the tool-free answer path and
 * the tool round-trip phase (validator, beforeToolExecution, checkpoint
 * intent/result, toolStarted/toolCompleted events, error observations,
 * finalOutputTool, maxIterations) of runAgentLoop are implemented per
 * docs/migration/typescript-core/loop-and-state.md. Iteration/budget guards,
 * soft-stop/hard-cancel and observer-error isolation land in later P2 cards.
 */

export type {
  AgentRequest,
  AgentResult,
  AgentEvent,
  AgentDependencies,
  LoopCheckpoint,
  StopReason,
} from "./types.ts";
export type { ToolExecutor, ToolValidator, ToolObservation } from "./tools.ts";
export { LoopError, runAgentLoop } from "./agent-loop.ts";
