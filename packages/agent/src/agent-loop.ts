import type {
  AgentMessage,
  ContentBlock,
  ModelRequest,
  ModelResponse,
  TokenUsage,
  ToolCall,
  ToolResultMessage,
  UsageCost,
  UserMessage,
} from "@di/ai";
import { textOfMessage } from "@di/ai";
import type { ToolObservation } from "./tools.ts";
import type { AgentDependencies, AgentEvent, AgentRequest, AgentResult } from "./types.ts";

/**
 * ReAct loop (Di baseline `Core/AgentLoop/ReAct.cs` `RunCoreAsync`; contract per
 * docs/migration/typescript-core/loop-and-state.md §"一回合精确时序").
 *
 * P2.1 landed the tool-free answer path; P2.2 adds the tool phase: after the
 * model returns tool call(s), each call is validated, the pre-execution hook and
 * hard-signal check gate it, the checkpoint intent is written, `toolStarted` is
 * emitted, the tool executes (a throwing tool becomes an `isError` observation,
 * never a crash or a fabricated success), `toolCompleted` is emitted, the
 * observation is appended as a `ToolResultMessage`, and the checkpoint result is
 * written before the next model call. Multiple tools in one round execute in
 * order. `finalOutputTool` returns the raw arguments as the answer;
 * `maxIterations` stops the loop and does not execute tools on the final turn.
 *
 * Pure loop logic only: no Node IO, no fs, no disk. The loop never mutates the
 * caller's `history` array; every run builds its own trajectory.
 */

/** A loop-level protocol/parameter error with a stable machine-readable code. */
export class LoopError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LoopError";
    this.code = code;
  }
}

/** Identity element for {@link addUsage}: a model call with nothing reported. */
const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * Run one agent turn against an injected {@link ChatModel}.
 *
 * The loop alternates model and tool phases until the model answers without
 * tool calls, the caller's `finalOutputTool` is hit, or `maxIterations` is
 * exhausted. A model call is always made before any tool runs, so an explicit
 * budget of `N` means at most N model calls (0 = unlimited).
 */
export async function runAgentLoop(
  request: AgentRequest,
  dependencies: AgentDependencies,
  signal?: AbortSignal,
): Promise<AgentResult> {
  validateRequest(request, dependencies);

  // Trajectory = history + current user message, without touching the caller's array.
  const trajectory: AgentMessage[] = [...request.history, userMessage(request.userMessage)];
  const maxIterations = request.maxIterations ?? 0;

  let usage: TokenUsage = ZERO_USAGE;
  let cost: UsageCost | undefined;
  let iterations = 0;

  while (maxIterations === 0 || iterations < maxIterations) {
    // Phase boundary B0: hard abort before starting any model call.
    signal?.throwIfAborted();

    // Model phase: one call per iteration.
    iterations += 1;
    const response = await streamModel(request, trajectory, dependencies, signal);

    usage = addUsage(usage, response.usage);
    cost = combineCost(cost, response.cost);
    trajectory.push(response.message);

    // The full assistant message is durable before anything else happens.
    await dependencies.checkpoint?.appendMessage(response.message);

    const turnCompleted: AgentEvent = {
      type: "turnCompleted",
      iteration: iterations,
      usage,
      finishReason: response.finishReason,
      ...(cost === undefined ? {} : { cost }),
    };
    await emit(dependencies, turnCompleted);

    const toolCalls = response.message.content.filter(isToolCall);
    if (toolCalls.length === 0) {
      return {
        answer: lastAssistantText(trajectory),
        trajectory,
        history: request.history,
        usage,
        cost,
        iterations,
        stopReason: "answer",
      };
    }

    // Tool phase: process the model's calls in the order given.
    for (const call of toolCalls) {
      // Final-output tool: the model declares the task complete; its arguments are the answer.
      if (request.finalOutputTool !== undefined && call.name === request.finalOutputTool) {
        return {
          answer: call.arguments,
          trajectory,
          history: request.history,
          usage,
          cost,
          iterations,
          stopReason: "final_output_tool",
        };
      }

      // Explicit positive budget exhausted: do not run tools whose observations
      // no further model call would consume; the loop then returns max_iterations.
      if (maxIterations > 0 && iterations >= maxIterations) {
        break;
      }

      // Validation, the pre-execution hook and the hard-signal check gate the tool.
      await dependencies.toolValidator?.validate(call, signal);
      await dependencies.beforeToolExecution?.(trajectory);
      signal?.throwIfAborted();

      // Write-ahead intent: on failure the tool never runs.
      await dependencies.checkpoint?.toolStarted(call);
      await emit(dependencies, { type: "toolStarted", call });

      // Execute; a throwing tool becomes an error observation, never a crash.
      const observation = await executeTool(dependencies, call, signal);
      const toolResult: ToolResultMessage = {
        role: "tool",
        toolCallId: call.id,
        content: observation.text,
        isError: observation.isError,
      };

      await emit(dependencies, {
        type: "toolCompleted",
        call,
        observation: observation.text,
        isError: observation.isError,
      });
      trajectory.push(toolResult);

      // The result is durable before the next model call is allowed to start.
      await dependencies.checkpoint?.toolCompleted(toolResult);
    }
  }

  // Explicit iteration budget exhausted (no remaining model calls).
  return {
    answer: lastAssistantText(trajectory),
    trajectory,
    history: request.history,
    usage,
    cost,
    iterations,
    stopReason: "max_iterations",
  };
}

// ---------------------------------------------------------------------------
// Request well-formedness
// ---------------------------------------------------------------------------

/** Rejects malformed requests per loop-and-state.md §"逐单元红绿实施与验收边界". */
function validateRequest(request: AgentRequest, dependencies: AgentDependencies): void {
  if (request == null || dependencies == null) {
    throw new TypeError("runAgentLoop: request and dependencies are required");
  }
  if (dependencies.model == null) {
    throw new TypeError("runAgentLoop: dependencies.model is required");
  }
  if (request.maxIterations !== undefined && (!Number.isInteger(request.maxIterations) || request.maxIterations < 0)) {
    throw new RangeError(
      `runAgentLoop: maxIterations must be an integer >= 0 (0 = unlimited), got ${request.maxIterations}`,
    );
  }
  if (request.maxTokens !== undefined && (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0)) {
    throw new RangeError(`runAgentLoop: maxTokens must be a positive integer, got ${request.maxTokens}`);
  }
  if (
    request.contextTokenBudget !== undefined &&
    (!Number.isInteger(request.contextTokenBudget) || request.contextTokenBudget < 0)
  ) {
    throw new RangeError(
      `runAgentLoop: contextTokenBudget must be an integer >= 0, got ${request.contextTokenBudget}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Model phase
// ---------------------------------------------------------------------------

/** One model call: forward deltas, take the last `completed` response. */
async function streamModel(
  request: AgentRequest,
  trajectory: readonly AgentMessage[],
  dependencies: AgentDependencies,
  signal: AbortSignal | undefined,
): Promise<ModelResponse> {
  const modelRequest = buildModelRequest(request, trajectory);
  let completed: ModelResponse | undefined;
  for await (const event of dependencies.model.stream(modelRequest, signal)) {
    switch (event.type) {
      case "textDelta":
        await emit(dependencies, { type: "textDelta", delta: event.delta });
        break;
      case "reasoningDelta":
        await emit(dependencies, { type: "reasoningDelta", delta: event.delta });
        break;
      case "toolCallDelta":
        await emit(dependencies, {
          type: "toolCallDelta",
          id: event.id,
          name: event.name,
          arguments: event.arguments,
        });
        break;
      case "completed":
        completed = event.response;
        break;
    }
  }
  if (completed === undefined) {
    throw new LoopError(
      "missing-completed",
      "runAgentLoop: the model stream ended before emitting a completed event; the response is not well-formed.",
    );
  }
  return completed;
}

/** Stable system prompt + trajectory + volatile trailing system context (per ReAct.BuildContext). */
function buildModelRequest(request: AgentRequest, trajectory: readonly AgentMessage[]): ModelRequest {
  const messages: AgentMessage[] = [];
  if (request.systemPrompt.trim().length > 0) {
    messages.push({ role: "system", text: request.systemPrompt });
  }
  messages.push(...trajectory);
  if (request.systemContext !== undefined && request.systemContext.trim().length > 0) {
    messages.push({ role: "system", text: request.systemContext });
  }
  return {
    messages,
    tools: request.tools,
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
  };
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/** Await the observer sink to preserve event order (error isolation is a later P2 card). */
async function emit(dependencies: AgentDependencies, event: AgentEvent): Promise<void> {
  await dependencies.events?.(event);
}

// ---------------------------------------------------------------------------
// Tool phase
// ---------------------------------------------------------------------------

/**
 * Execute one tool call. A throwing tool becomes an `isError` observation the
 * model can recover from; only a hard-cancel `AbortError` propagates as a
 * rejection (loop-and-state.md: AbortError must never become a plain
 * observation). No fake success is ever fabricated.
 */
async function executeTool(
  dependencies: AgentDependencies,
  call: ToolCall,
  signal: AbortSignal | undefined,
): Promise<ToolObservation> {
  try {
    return await dependencies.toolExecutor.execute(call, signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return { text: `error executing tool '${call.name}': ${errorMessage(error)}`, isError: true };
  }
}

/** True when `error` is a DOM-style AbortError (hard-cancel), never an observation. */
function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { readonly name?: unknown }).name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function userMessage(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function lastAssistantText(trajectory: readonly AgentMessage[]): string {
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const message = trajectory[i];
    if (message !== undefined && message.role === "assistant") {
      return textOfMessage(message);
    }
  }
  return "";
}

function isToolCall(block: ContentBlock): block is ToolCall {
  return block.type === "tool-call";
}

/** Accumulate usage; optional counts sum only when both sides report them. */
function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.totalTokens !== undefined || b.totalTokens !== undefined
      ? { totalTokens: sumOrNull(a.totalTokens, b.totalTokens) }
      : {}),
    ...(a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined
      ? { cacheReadTokens: sumOrNull(a.cacheReadTokens, b.cacheReadTokens) }
      : {}),
    ...(a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: sumOrNull(a.cacheWriteTokens, b.cacheWriteTokens) }
      : {}),
    ...(a.reasoningTokens !== undefined || b.reasoningTokens !== undefined
      ? { reasoningTokens: sumOrNull(a.reasoningTokens, b.reasoningTokens) }
      : {}),
  };
}

/** Sum optional counts; a missing side (undefined = not reported) keeps the other side. */
function sumOrNull(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + b;
}

/** Accumulate cost; a missing side keeps the other (null-safe per C# CombineCost). */
function combineCost(acc: UsageCost | undefined, next: UsageCost | undefined): UsageCost | undefined {
  if (next === undefined) return acc;
  if (acc === undefined) return next;
  return {
    input: acc.input + next.input,
    output: acc.output + next.output,
    cacheRead: acc.cacheRead + next.cacheRead,
    cacheWrite: acc.cacheWrite + next.cacheWrite,
  };
}
