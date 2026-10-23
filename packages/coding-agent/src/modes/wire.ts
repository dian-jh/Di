import type { AgentEvent, AgentResult, StopReason } from "@di/agent";
import type { LlmFailure, TokenUsage, ToolCall } from "@di/ai";
import type {
  AgentEvent as RpcAgentEvent,
  AgentResult as RpcAgentResult,
  RunFailure as RpcRunFailure,
  TokenUsage as RpcTokenUsage,
} from "di-tui/protocol";
import { usageCostTotal } from "./event-renderer.ts";

/*
 * Core AgentLoop 事件/结果 → TUI wire 载荷的共享转换（docs/tui-rpc.md 为权威，
 * `tui/src/rpc/protocol.ts` 为形状）。RPC 模式（--mode rpc 子进程路径）与
 * LocalAgentRunnerAdapter（同进程 TUI 路径）共用同一转换函数，保证两种后端
 * 的 wire 载荷字节级等价（字段值、顺序一致）。
 *
 * 约定（对齐 rpc-mode 原实现，docs/tui-rpc.md）：snake_case、null 键省略、
 * `interrupted` 事件 kind 不发出（TUI codec 拒绝该 kind，软停经
 * result.stop_reason "interrupted" 上报）、interrupt 合成 `cancelled`。
 */

/** 每回合单调递增的事件/result 序号（回合内自 1 连续）。 */
export class SeqCounter {
  private value = 0;

  next(): number {
    this.value += 1;
    return this.value;
  }
}

/** StopReason → protocol wire 值（全部 Core StopReason 映射到自身）。 */
export function stopReasonWire(reason: StopReason): string {
  switch (reason) {
    case "answer":
    case "final_output_tool":
    case "max_iterations":
    case "error":
    case "interrupted":
    case "context_limit":
      return reason;
    default:
      return "error";
  }
}

/** TokenUsage → protocol payload（snake_case，null 键省略；无计算字段）。 */
export function usagePayload(usage: TokenUsage): RpcTokenUsage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cache_read_tokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cache_write_tokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoning_tokens: usage.reasoningTokens } : {}),
  };
}

/** AgentResult → protocol result payload（stop_reason 六值直映射 + interrupt 合成 cancelled）。 */
export function resultPayload(result: AgentResult): RpcAgentResult {
  return {
    answer: result.answer,
    stop_reason: stopReasonWire(result.stopReason) as RpcAgentResult["stop_reason"],
    iterations: result.iterations,
    usage: usagePayload(result.usage),
    ...(result.cost !== undefined ? { cost: usageCostTotal(result.cost) } : {}),
    ...(result.failure !== undefined ? { failure: { code: result.failure.code, message: result.failure.message } } : {}),
  };
}

/** ToolCall → protocol call payload。 */
export function callPayload(call: ToolCall): { id: string; name: string; arguments: string } {
  return { id: call.id, name: call.name, arguments: call.arguments };
}

/** LlmFailure → protocol failure payload（code/message 必填；status / retry-after 可选）。 */
export function failurePayload(failure: LlmFailure): RpcRunFailure {
  return {
    code: failure.code,
    message: failure.message,
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.providerRetryAfterMs !== undefined ? { provider_retry_after: failure.providerRetryAfterMs / 1000 } : {}),
  };
}

/** AgentLoopEvent → protocol event payload。`interrupted` 返回 undefined（线上省略）。 */
export function eventPayload(event: AgentEvent): RpcAgentEvent | undefined {
  switch (event.type) {
    case "textDelta":
      return { kind: "text_delta", delta: event.delta };
    case "reasoningDelta":
      return { kind: "reasoning_delta", delta: event.delta };
    case "toolCallDelta":
      return { kind: "tool_call_delta", id: event.id, name: event.name, arguments: event.arguments };
    case "toolStarted":
      return { kind: "tool_started", call: callPayload(event.call) };
    case "toolCompleted":
      return { kind: "tool_completed", call: callPayload(event.call), observation: event.observation, is_error: event.isError };
    case "turnCompleted":
      return {
        kind: "turn_completed",
        iteration: event.iteration,
        usage: usagePayload(event.usage),
        ...(event.cost !== undefined ? { cost: usageCostTotal(event.cost) } : {}),
        finish_reason: event.finishReason.type,
      };
    case "runFailed":
      return { kind: "run_failed", failure: failurePayload(event.failure) };
    case "interrupted":
      // docs/tui-rpc.md 列出该 kind，但 TUI codec（tui/src/rpc/codec.ts）不接受它——
      // 发出即 malformed。软停仍经 result.stop_reason "interrupted" 上报（与 分歧）。
      return undefined;
  }
}

/** 合成回合（cancelled / error）用的零 usage。 */
export function zeroUsage(): RpcTokenUsage {
  return { input_tokens: 0, output_tokens: 0 };
}

/** 是否 AbortError（硬取消 → 合成 cancelled result）。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
