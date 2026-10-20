/**
 * @di/agent — pure ReAct loop vocabulary.
 *
 * P2.1 status: the loop-owned types (AgentResult, AgentEvent, AgentDependencies,
 * LoopCheckpoint, StopReason) and the tool-free answer path of runAgentLoop are
 * implemented per docs/migration/typescript-core/loop-and-state.md. Tool
 * round-trip, iteration/budget limits, soft-stop/hard-cancel and observer-error
 * isolation land in later P2 cards.
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
