/**
 * @di/agent — pure ReAct loop vocabulary.
 *
 * P1 status: compilable workspace stub. The loop contracts defined in
 * docs/migration/typescript-core/loop-and-state.md (AgentRequest, AgentResult,
 * AgentEvent, ToolExecutor, ToolValidator, LoopCheckpoint, runAgentLoop) are
 * implemented in P2 per execution-plan.md. Only stable pre-defined types are
 * exported here so the package resolves in workspace dependency order.
 */

/** Why a loop run stopped (from `Core/AgentLoop/AgentResult.cs` `AgentStopReason`). */
export type StopReason =
  | "answer"
  | "final_output_tool"
  | "max_iterations"
  | "error"
  | "interrupted"
  | "context_limit";
