/*
 * @di/agent — pure ReAct loop vocabulary.
 *
 * + status: the loop-owned types (AgentResult, AgentEvent,
 * AgentDependencies, LoopCheckpoint, StopReason), the tool-free answer path and
 * the tool round-trip phase (validator, beforeToolExecution, checkpoint
 * intent/result, toolStarted/toolCompleted events, error observations,
 * finalOutputTool, maxIterations) of runAgentLoop are implemented per
 *
 * guard (`contextTokenBudget`/`estimateRequestTokens` -> `context_limit` with the
 * trajectory preserved). adds soft-stop (`interruptRequested` -> `interrupted`
 * at both phase boundaries, never starting a pending tool or another model call)
 * and hard cancel (`AbortSignal` rejection, never an `isError` observation).
 * isolates observer errors: `events` is a side channel caught and ordered
 * through `onObserverError` (its own errors swallowed) — it never stalls the
 * loop, blocks an authorized tool or fails a successful turn; checkpoint hooks
 * stay fail-closed (errors abort the loop unchanged).
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
