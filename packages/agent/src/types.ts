import type {
  AgentMessage,
  ChatModel,
  FinishReason,
  LlmFailure,
  ModelRequest,
  TokenUsage,
  ToolCall,
  ToolResultMessage,
  ToolSpec,
  UsageCost,
} from "@di/ai";
import type { ToolExecutor, ToolValidator } from "./tools.ts";

/**
 * Public request, result, event, and dependency types for `@di/agent`.
 * AgentResult / AgentEvent / AgentDependencies / LoopCheckpoint / StopReason).
 *
 * Message and tool-schema vocabulary is imported from @di/ai; never redefined
 * here. These exported interfaces and unions define the public loop contract.
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

/** Why a loop run stopped (from `AgentStopReason`). */
export type StopReason =
  | "answer"
  | "final_output_tool"
  | "max_iterations"
  | "error"
  | "interrupted"
  | "context_limit";

/** One observable event emitted by the loop. */
export type AgentEvent =
  | { readonly type: "textDelta"; readonly delta: string }
  | { readonly type: "reasoningDelta"; readonly delta: string }
  | { readonly type: "toolCallDelta"; readonly id: string; readonly name: string; readonly arguments: string }
  | {
      readonly type: "turnCompleted";
      readonly iteration: number;
      readonly usage: TokenUsage;
      readonly cost?: UsageCost;
      readonly finishReason: FinishReason;
    }
  | { readonly type: "toolStarted"; readonly call: ToolCall }
  | { readonly type: "toolCompleted"; readonly call: ToolCall; readonly observation: string; readonly isError: boolean }
  | { readonly type: "runFailed"; readonly failure: LlmFailure }
  | { readonly type: "interrupted" };

/** The loop's outcome for one run. */
export interface AgentResult {
  /** Final visible text (last assistant message; partial or empty on non-answer stops). */
  answer: string;
  /** Full trajectory (history + user + assistant + tool messages) — replayable state. */
  trajectory: readonly AgentMessage[];
  /** The caller's cross-turn history, returned untouched (session log skips it). */
  history: readonly AgentMessage[];
  /** Accumulated token usage across all model calls. */
  usage: TokenUsage;
  /** Accumulated cost across all model calls; absent when no catalog rates apply. */
  cost?: UsageCost;
  /** Number of model calls actually executed. */
  iterations: number;
  stopReason: StopReason;
  /** Set when stopReason is "error". */
  failure?: LlmFailure;
}

/** Durable checkpoint seam: write-ahead intent/result persistence owned by the host. */
export interface LoopCheckpoint {
  appendMessage(message: AgentMessage): void | Promise<void>;
  toolStarted(call: ToolCall): void | Promise<void>;
  toolCompleted(result: ToolResultMessage): void | Promise<void>;
}

/** Everything the loop needs injected (loop-and-state.md §"建议公开的最小 loop types"). */
export interface AgentDependencies {
  model: ChatModel;
  toolExecutor: ToolExecutor;
  /** Pure or injected estimate helper; never a Node Buffer API. */
  estimateRequestTokens: (request: ModelRequest) => number;
  toolValidator?: ToolValidator;
  /** Observer only; exceptions are isolated and diagnosed (later card). */
  events?: (event: AgentEvent) => void | Promise<void>;
  /** Ordered diagnostic side channel; its own errors are swallowed. */
  onObserverError?: (error: unknown, event: AgentEvent) => void | Promise<void>;
  checkpoint?: LoopCheckpoint;
  /** Soft stop: polled at phase boundaries before a model/tool phase starts. */
  interruptRequested?: () => boolean;
  beforeToolExecution?: (trajectory: readonly AgentMessage[]) => void | Promise<void>;
}
