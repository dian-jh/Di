import type { AgentMessage, ToolSpec } from "@di/ai";

/**
 * @di/agent loop types (P1.2: the tool-calling vocabulary + AgentRequest).
 *
 * The remaining loop types (AgentResult, AgentEvent, AgentDependencies,
 * LoopCheckpoint, runAgentLoop) are added in P2 per execution-plan.md. Message
 * and tool-schema vocabulary is imported from @di/ai; never redefined here.
 */

export interface AgentRequest {
  sessionId: string;
  systemPrompt: string;
  userMessage: string;
  history: readonly AgentMessage[];
  systemContext?: string;
  /** Model-facing tool schemas; executors/validators live in `tools.ts`. */
  tools: readonly ToolSpec[];
  /** Host-provided estimate guard; not a provider tokenizer's exact token limit. */
  contextTokenBudget?: number;
  /** Default 0; 0 = unlimited, positive integer = max model calls. */
  maxIterations?: number;
  /** Per-model-call max output tokens; omitted = provider/model default. */
  maxTokens?: number;
  /** Opaque provider/model value; the adapter validates support. */
  reasoningEffort?: string;
  finalOutputTool?: string;
}
