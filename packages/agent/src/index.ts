/**
 * @di/agent — pure ReAct loop vocabulary.
 *
 * P1 status: compilable workspace stub. The tool-calling vocabulary and
 * AgentRequest are exported here (P1.2). The loop contracts defined in
 * docs/migration/typescript-core/loop-and-state.md (AgentResult, AgentEvent,
 * AgentDependencies, LoopCheckpoint, runAgentLoop) are implemented in P2 per
 * execution-plan.md.
 */

/** Why a loop run stopped (from `Core/AgentLoop/AgentResult.cs` `AgentStopReason`). */
export type StopReason =
  | "answer"
  | "final_output_tool"
  | "max_iterations"
  | "error"
  | "interrupted"
  | "context_limit";

export type { AgentRequest } from "./types.ts";
export type { ToolExecutor, ToolValidator, ToolObservation } from "./tools.ts";
