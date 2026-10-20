import type { ContentBlock, ImageBlock, ReasoningBlock, ToolCall } from "../../types/content.ts";
import { isTextBlock } from "../../types/content.ts";
import type { AgentMessage, AssistantMessage } from "../../types/messages.ts";
import type { FinishReason, LlmFailure, ModelRequest, TokenUsage } from "../../types/model.ts";
import type { ToolSpec } from "../../types/tools.ts";
import type { ProviderChunk } from "../../stream-assembler.ts";
import type { SseEvent, TranslateEvent } from "../../sse.ts";
import type {
  DeepSeekWireChunk,
  DeepSeekWireChunkChoice,
  DeepSeekWireCompletionTokensDetails,
  DeepSeekWireContentPart,
  DeepSeekWireDelta,
  DeepSeekWireFunctionCall,
  DeepSeekWireMessage,
  DeepSeekWirePromptTokensDetails,
  DeepSeekWireRequest,
  DeepSeekWireThinking,
  DeepSeekWireTool,
  DeepSeekWireToolCall,
  DeepSeekWireUsage,
} from "./wire.ts";

/**
 * DeepSeek ↔ unified vocabulary translation (Di baseline
 * `Core/Providers/DeepSeek/DeepSeekTranslator.cs` + `DeepSeekDefaults.cs`).
 * All DeepSeek-specific quirks live here — the business and the host never see
 * the wire format (docs/modules/deepseek.md).
 *
 * Request side: {@link toWireRequest} maps the internal AgentMessage/ToolSpec
 * history onto the wire DTO; {@link serializeRequest} emits byte-stable JSON in
 * the C# serializer's field order (unset fields omitted, never `[]`/`null`).
 *
 * Response side: {@link createDeepSeekTranslator} is a stateful closure that
 * plugs into the `TranslateEvent` seam of `sseToModelEvents` (P3.2). It maps one
 * raw `data:` line onto {@link ProviderChunk}s, synthesizing block boundaries
 * for DeepSeek's delta stream, skipping bad JSON lines (never crashing), and
 * treating `[DONE]` as the no-op terminal marker. Transport failures remain
 * `SseStreamError`s from `sseToModelEvents`; HTTP failures map via
 * {@link mapHttpErrorBody} into {@link DeepSeekError}.
 */

/** DeepSeek protocol constants (from `Core/Providers/DeepSeek/DeepSeekDefaults.cs`). */
export const deepSeekDefaults = {
  baseUrl: "https://api.deepseek.com",
  chatCompletionsPath: "/chat/completions",
  maxTokensLimit: 393_216,
  stopLimit: 16,
  /**
   * Response-header wait timeout in seconds (C# `RequestTimeoutSeconds` = 60):
   * the server must start responding within this window or the request fails
   * with a retryable `TIMEOUT`. Not a total-duration timeout.
   */
  requestTimeoutSeconds: 60,
} as const;

const ThinkingType = {
  Enabled: "enabled",
  Disabled: "disabled",
} as const;

const ReasoningEffort = {
  None: "none",
  Low: "low",
  High: "high",
  Max: "max",
} as const;

const ToolType = "function";

const ToolChoiceAuto = "auto";

/** Stable, machine-readable error codes (mirrors `Core/Llm/LlmErrorCodes.cs`). */
export const deepSeekErrorCodes = {
  missingCredential: "MISSING_CREDENTIAL",
  unsupportedOption: "UNSUPPORTED_OPTION",
  invalidRequest: "INVALID_REQUEST",
  rateLimited: "RATE_LIMITED",
  timeout: "TIMEOUT",
  connection: "CONNECTION",
  badResponse: "BAD_RESPONSE",
  insufficientSystemResource: "INSUFFICIENT_SYSTEM_RESOURCE",
  contentFiltered: "CONTENT_FILTERED",
  aborted: "ABORTED",
  unknownFinishReason: "UNKNOWN_FINISH_REASON",
} as const;

// ---------------------------------------------------------------------------
// Request side
// ---------------------------------------------------------------------------

/**
 * Map a unified {@link ModelRequest} onto the DeepSeek wire DTO.
 * `model` is the provider model id bound to the adapter. Unset collections stay
 * omitted (byte-stable prefix cache); `stream:true` + `include_usage` are always
 * requested; `tool_choice` defaults to `auto` when tools are present (the unified
 * vocabulary has no tool-choice option, matching the C# default).
 */
export function toWireRequest(request: ModelRequest, model: string): DeepSeekWireRequest {
  const hasTools = request.tools !== undefined && request.tools.length > 0;

  if (request.maxTokens !== undefined && request.maxTokens > deepSeekDefaults.maxTokensLimit) {
    throw new DeepSeekError({
      message: `MaxTokens 超过上限 ${deepSeekDefaults.maxTokensLimit}。`,
      code: deepSeekErrorCodes.invalidRequest,
    });
  }

  const thinking = buildThinking(request.reasoningEffort);

  return {
    messages: request.messages.map(toWireMessage),
    model,
    ...(thinking !== undefined ? { thinking } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    stream: true,
    streamOptions: { includeUsage: true },
    ...(hasTools && request.tools !== undefined
      ? { tools: request.tools.map(toWireTool), toolChoice: ToolChoiceAuto }
      : {}),
  };
}

function toWireMessage(message: AgentMessage): DeepSeekWireMessage {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.text };
    case "user":
      return toWireUser(message.content);
    case "assistant":
      return toWireAssistant(message);
    case "tool":
      return { role: "tool", content: message.content, toolCallId: message.toolCallId };
    default: {
      const exhaustive: never = message;
      throw new DeepSeekError({ message: `未知消息角色 '${(exhaustive as { role?: string }).role ?? "?"}'。`, code: deepSeekErrorCodes.invalidRequest });
    }
  }
}

function toWireUser(content: readonly ContentBlock[]): DeepSeekWireMessage {
  const wireContent = toWireContent(content);
  if (wireContent === undefined) return { role: "user" };
  return { role: "user", content: wireContent };
}

function toWireAssistant(message: AssistantMessage): DeepSeekWireMessage {
  const text = message.content.filter(isTextBlock).map((b) => b.text).join("");

  // 带 tools 的历史 reasoning 必须完整回传（否则 DeepSeek 400）——保留实际值即可。
  const reasoning = message.content.filter(isReasoningBlock).map((b) => b.text)[0];

  const toolCalls = message.content.filter((b): b is ToolCall => b.type === "tool-call");

  return {
    role: "assistant",
    ...(text !== "" ? { content: text } : {}),
    ...(reasoning !== undefined ? { reasoningContent: reasoning } : {}),
    ...(toolCalls.length > 0
      ? {
          toolCalls: toolCalls.map((call) => ({
            id: call.id,
            type: ToolType,
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
  };
}

function toWireContent(
  content: readonly ContentBlock[],
): string | readonly DeepSeekWireContentPart[] | undefined {
  if (content.length === 0) return undefined;

  // 纯文本走 string 形态（与官方样例一致，也最省 token）。
  if (content.every(isTextBlock)) return content.map((b) => b.text).join("");

  const parts: DeepSeekWireContentPart[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      parts.push({ type: "text", text: block.text });
    } else if (isImageBlock(block)) {
      parts.push({
        type: "image_url",
        imageUrl:
          block.detail === undefined ? { url: block.attachmentId } : { url: block.attachmentId, detail: block.detail },
      });
    } else {
      throw new DeepSeekError({
        message: `DeepSeek 不支持 user 消息中的块类型 '${block.type}'。`,
        code: deepSeekErrorCodes.unsupportedOption,
      });
    }
  }
  return parts;
}

function toWireTool(tool: ToolSpec): DeepSeekWireTool {
  if (tool.name.length > 128) {
    throw new DeepSeekError({
      message: `工具名 '${tool.name}' 超过 128 字符。`,
      code: deepSeekErrorCodes.invalidRequest,
    });
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.strict === true ? { strict: true } : {}),
    },
  };
}

function buildThinking(reasoningEffort: string | undefined): DeepSeekWireThinking | undefined {
  let effort: string | undefined;
  switch (reasoningEffort) {
    case undefined:
    case "default":
      effort = undefined;
      break;
    case "off":
    case "none":
      effort = ReasoningEffort.None;
      break;
    case "low":
      effort = ReasoningEffort.Low;
      break;
    case "high":
      effort = ReasoningEffort.High;
      break;
    case "max":
      effort = ReasoningEffort.Max;
      break;
    default:
      throw new DeepSeekError({
        message: `DeepSeek 不支持推理强度 '${reasoningEffort}'（支持：off/low/high/max）。`,
        code: deepSeekErrorCodes.unsupportedOption,
      });
  }

  if (effort === undefined) return undefined; // 默认：DeepSeek 默认开启思考，effort=high
  if (effort === ReasoningEffort.None) return { type: ThinkingType.Disabled };
  return { type: ThinkingType.Enabled, reasoningEffort: effort };
}

/**
 * Serialize a wire request to byte-stable JSON in the C# serializer's field
 * order (`JsonNamingPolicy.SnakeCaseLower` + `WhenWritingNull`), so unset
 * fields never appear as `null`/`[]` and the request prefix stays cacheable.
 */
export function serializeRequest(wire: DeepSeekWireRequest): string {
  const body: Record<string, unknown> = {
    messages: wire.messages.map(serializeWireMessage),
    model: wire.model,
  };
  if (wire.thinking !== undefined) {
    const thinking: Record<string, unknown> = { type: wire.thinking.type };
    if (wire.thinking.reasoningEffort !== undefined) thinking.reasoning_effort = wire.thinking.reasoningEffort;
    body.thinking = thinking;
  }
  if (wire.maxTokens !== undefined) body.max_tokens = wire.maxTokens;
  body.stream = wire.stream;
  body.stream_options = { include_usage: wire.streamOptions.includeUsage };
  if (wire.tools !== undefined) body.tools = wire.tools.map(serializeWireTool);
  if (wire.toolChoice !== undefined) body.tool_choice = wire.toolChoice;
  return JSON.stringify(body);
}

function serializeWireMessage(message: DeepSeekWireMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role };
  if (message.content !== undefined) {
    out.content = typeof message.content === "string" ? message.content : message.content.map(serializeWireContentPart);
  }
  if (message.reasoningContent !== undefined) out.reasoning_content = message.reasoningContent;
  if (message.toolCalls !== undefined) out.tool_calls = message.toolCalls.map(serializeWireToolCall);
  if (message.toolCallId !== undefined) out.tool_call_id = message.toolCallId;
  return out;
}

function serializeWireContentPart(part: DeepSeekWireContentPart): Record<string, unknown> {
  const out: Record<string, unknown> = { type: part.type };
  if (part.text !== undefined) out.text = part.text;
  if (part.imageUrl !== undefined) {
    const image: Record<string, unknown> = { url: part.imageUrl.url };
    if (part.imageUrl.detail !== undefined) image.detail = part.imageUrl.detail;
    out.image_url = image;
  }
  return out;
}

function serializeWireTool(tool: DeepSeekWireTool): Record<string, unknown> {
  const fn: Record<string, unknown> = { name: tool.function.name };
  if (tool.function.description !== undefined) fn.description = tool.function.description;
  if (tool.function.parameters !== undefined) fn.parameters = tool.function.parameters;
  if (tool.function.strict === true) fn.strict = true;
  return { type: tool.type, function: fn };
}

function serializeWireToolCall(call: DeepSeekWireToolCall): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (call.id !== undefined) out.id = call.id;
  if (call.type !== undefined) out.type = call.type;
  if (call.index !== undefined) out.index = call.index;
  if (call.function !== undefined) {
    const fn: Record<string, unknown> = {};
    if (call.function.name !== undefined) fn.name = call.function.name;
    if (call.function.arguments !== undefined) fn.arguments = call.function.arguments;
    out.function = fn;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response side
// ---------------------------------------------------------------------------

/**
 * Create the DeepSeek SSE data-line → {@link ProviderChunk} translator for one
 * stream. Stateful (blocks open across events) and plugs into the P3.2
 * `TranslateEvent` seam of `sseToModelEvents`.
 *
 * Block index allocation is fixed so the assembled content order matches the C#
 * assembler (reasoning → text → tool calls sorted by wire index):
 * reasoning = 0, text = 1, tool call with wire index n = 2 + n.
 * A terminal finish chunk closes all open blocks before the `finish` chunk.
 */
export function createDeepSeekTranslator(): TranslateEvent {
  let responseIdEmitted = false;
  const openBlocks: Array<{ readonly providerIndex: number }> = [];

  return (event: SseEvent): readonly ProviderChunk[] => {
    // [DONE] 是 DeepSeek 结束标记；真正的收尾 finish chunk 在其之前到达。
    if (event.data === "[DONE]") return [];

    const chunk = parseWireChunk(event.data);
    if (chunk === undefined) return []; // 坏 JSON / 结构非法：跳过，不让整个流崩掉

    const out: ProviderChunk[] = [];

    // 首个携带 id 的 chunk 上报响应标识（用于追溯/日志）。
    if (!responseIdEmitted && chunk.id !== undefined) {
      responseIdEmitted = true;
      out.push({ type: "responseInfo", responseId: chunk.id });
    }

    if (chunk.usage !== undefined) {
      out.push({ type: "usage", usage: mapUsage(chunk.usage) });
    }

    const choice = chunk.choices?.[0];
    if (choice !== undefined) {
      const delta = choice.delta;
      if (delta !== undefined) {
        if (delta.reasoningContent !== undefined && delta.reasoningContent !== "") {
          ensureBlock(out, 0, "reasoning");
          out.push({ type: "reasoningDelta", index: 0, delta: delta.reasoningContent });
        }
        if (delta.content !== undefined && delta.content !== "") {
          ensureBlock(out, 1, "text");
          out.push({ type: "textDelta", index: 1, delta: delta.content });
        }
        if (delta.toolCalls !== undefined) {
          for (const call of delta.toolCalls) {
            const providerIndex = 2 + (call.index ?? 0);
            ensureBlock(out, providerIndex, "tool-call");
            out.push({
              type: "toolCallDelta",
              index: providerIndex,
              // 只在 wire 提供 id/name 时携带：assembler 对已定义值做覆盖，
              // 空串会把先前碎片里的真实 id 冲掉，所以缺失时保持省略。
              ...(call.id !== undefined ? { id: call.id } : {}),
              ...(call.function?.name !== undefined ? { name: call.function.name } : {}),
              argumentsDelta: call.function?.arguments ?? "",
            });
          }
        }
      }
      if (choice.finishReason !== undefined && choice.finishReason !== "") {
        for (const block of openBlocks) {
          out.push({ type: "blockEnd", index: block.providerIndex });
        }
        openBlocks.length = 0;
        out.push({ type: "finish", reason: mapFinishReason(choice.finishReason) });
      }
    }

    return out;
  };

  function ensureBlock(out: ProviderChunk[], providerIndex: number, kind: "reasoning" | "text" | "tool-call"): void {
    if (openBlocks.some((b) => b.providerIndex === providerIndex)) return;
    openBlocks.push({ providerIndex });
    out.push({ type: "blockStart", index: providerIndex, block: { type: kind } });
  }
}

/** Map a wire finish_reason onto the unified {@link FinishReason} vocabulary. */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "stop":
      return { type: "stop" };
    case "tool_calls":
      return { type: "tool-calls" };
    case "length":
      return { type: "max-tokens" };
    case "insufficient_system_resource":
      return {
        type: "error",
        failure: { message: "系统推理资源不足，生成被打断。", code: deepSeekErrorCodes.insufficientSystemResource, status: 503 },
      };
    case "content_filter":
      return {
        type: "error",
        failure: { message: "输出内容因触发过滤策略而被过滤。", code: deepSeekErrorCodes.contentFiltered },
      };
    case "aborted":
      return { type: "aborted", failure: { message: "生成过程被中断。", code: deepSeekErrorCodes.aborted } };
    default:
      return {
        type: "error",
        failure: { message: `未知 finish_reason: '${reason}'。`, code: deepSeekErrorCodes.unknownFinishReason },
      };
  }
}

/**
 * Map wire usage onto {@link TokenUsage}. Counts are disjoint: input excludes
 * cache hits; cache hits are reported separately (`CacheReadTokens`). Prefers the
 * top-level `prompt_cache_hit_tokens` over the nested `prompt_tokens_details.
 * cached_tokens`; missing `prompt_cache_miss_tokens` falls back to full prompt
 * minus cache hit. Missing nullable fields stay unknown (never zeroed).
 */
export function mapUsage(usage: DeepSeekWireUsage): TokenUsage {
  const cacheRead = usage.promptCacheHitTokens ?? usage.promptTokensDetails?.cachedTokens;
  const input = usage.promptCacheMissTokens ?? Math.max(0, usage.promptTokens - (cacheRead ?? 0));
  return {
    inputTokens: input,
    outputTokens: usage.completionTokens,
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(usage.completionTokensDetails?.reasoningTokens !== undefined
      ? { reasoningTokens: usage.completionTokensDetails.reasoningTokens }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Non-2xx error mapping
// ---------------------------------------------------------------------------

/**
 * Map a non-2xx HTTP error body onto a structured {@link LlmFailure} (Di
 * baseline `DeepSeekAdapter.ParseDeepSeekError` + `MapErrorCode`). 429 →
 * RATE_LIMITED; 401/403 → MISSING_CREDENTIAL; otherwise the body's `code` /
 * `type`, falling back to INVALID_REQUEST. Retry/backoff policy is later card
 * P3.5 — this only produces the failure fact.
 */
export function mapHttpErrorBody(
  status: number,
  body: string | undefined,
  providerRetryAfterMs?: number,
): LlmFailure {
  let message: string | undefined;
  let type: string | undefined;
  let code: string | undefined;

  if (body !== undefined && body.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const error = (parsed as Record<string, unknown>).error;
        if (typeof error === "object" && error !== null && !Array.isArray(error)) {
          const record = error as Record<string, unknown>;
          if (typeof record.message === "string") message = record.message;
          if (typeof record.type === "string") type = record.type;
          if (typeof record.code === "string") code = record.code;
        }
      }
    } catch {
      // Body is not JSON — fall back to the raw text.
    }
  }

  const bodyText = body !== undefined && body.trim() !== "" ? body.trim() : undefined;
  return {
    message: message ?? type ?? bodyText ?? String(status),
    code: mapErrorCode(code, type, status),
    ...(status !== undefined ? { status } : {}),
    ...(providerRetryAfterMs !== undefined ? { providerRetryAfterMs } : {}),
  };
}

function mapErrorCode(code: string | undefined, type: string | undefined, status: number): string {
  if (status === 429) return deepSeekErrorCodes.rateLimited;
  if (status === 401 || status === 403) return deepSeekErrorCodes.missingCredential;
  return code ?? type ?? deepSeekErrorCodes.invalidRequest;
}

/**
 * Structured pre-flight / HTTP error thrown by the DeepSeek adapter and request
 * translator. Carries the {@link LlmFailure} fact plus convenience accessors for
 * the retry policy (P3.5). Distinct from `SseStreamError` (transport/protocol
 * failures thrown by `sseToModelEvents`).
 */
export class DeepSeekError extends Error {
  readonly failure: LlmFailure;

  constructor(failure: LlmFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "DeepSeekError";
    this.failure = failure;
  }

  get code(): string {
    return this.failure.code;
  }

  get status(): number | undefined {
    return this.failure.status;
  }

  get providerRetryAfterMs(): number | undefined {
    return this.failure.providerRetryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// Wire chunk parsing (unknown JSON → typed DTO at the provider boundary)
// ---------------------------------------------------------------------------

/** Parse and structurally validate one SSE data line; `undefined` means skip. */
function parseWireChunk(data: string): DeepSeekWireChunk | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(isRecord(value.usage) ? { usage: parseUsage(value.usage) } : {}),
    ...(Array.isArray(value.choices) ? { choices: parseChoices(value.choices) } : {}),
  };
}

function parseChoices(entries: readonly unknown[]): readonly DeepSeekWireChunkChoice[] {
  const choices: DeepSeekWireChunkChoice[] = [];
  for (const entry of entries) {
    const choice = parseChoice(entry);
    if (choice !== undefined) choices.push(choice);
  }
  return choices;
}

function parseChoice(value: unknown): DeepSeekWireChunkChoice | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(isRecord(value.delta) ? { delta: parseDelta(value.delta) } : {}),
    ...(typeof value.finish_reason === "string" ? { finishReason: value.finish_reason } : {}),
    ...(typeof value.index === "number" ? { index: value.index } : {}),
  };
}

function parseDelta(record: Record<string, unknown>): DeepSeekWireDelta {
  return {
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.reasoning_content === "string" ? { reasoningContent: record.reasoning_content } : {}),
    ...(typeof record.role === "string" ? { role: record.role } : {}),
    ...(Array.isArray(record.tool_calls) ? { toolCalls: parseToolCalls(record.tool_calls) } : {}),
  };
}

function parseToolCalls(entries: readonly unknown[]): readonly DeepSeekWireToolCall[] {
  const calls: DeepSeekWireToolCall[] = [];
  for (const entry of entries) {
    const call = parseToolCall(entry);
    if (call !== undefined) calls.push(call);
  }
  return calls;
}

function parseToolCall(value: unknown): DeepSeekWireToolCall | undefined {
  if (!isRecord(value)) return undefined;
  const functionCall: DeepSeekWireFunctionCall | undefined = isRecord(value.function)
    ? {
        ...(typeof value.function.name === "string" ? { name: value.function.name } : {}),
        ...(typeof value.function.arguments === "string" ? { arguments: value.function.arguments } : {}),
      }
    : undefined;
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(typeof value.index === "number" ? { index: value.index } : {}),
    ...(functionCall !== undefined ? { function: functionCall } : {}),
  };
}

function parseUsage(record: Record<string, unknown>): DeepSeekWireUsage {
  const promptTokensDetails: DeepSeekWirePromptTokensDetails | undefined =
    isRecord(record.prompt_tokens_details) && typeof record.prompt_tokens_details.cached_tokens === "number"
      ? { cachedTokens: record.prompt_tokens_details.cached_tokens }
      : undefined;
  const completionTokensDetails: DeepSeekWireCompletionTokensDetails | undefined =
    isRecord(record.completion_tokens_details) && typeof record.completion_tokens_details.reasoning_tokens === "number"
      ? { reasoningTokens: record.completion_tokens_details.reasoning_tokens }
      : undefined;
  return {
    promptTokens: typeof record.prompt_tokens === "number" ? record.prompt_tokens : 0,
    completionTokens: typeof record.completion_tokens === "number" ? record.completion_tokens : 0,
    ...(typeof record.total_tokens === "number" ? { totalTokens: record.total_tokens } : {}),
    ...(typeof record.prompt_cache_hit_tokens === "number"
      ? { promptCacheHitTokens: record.prompt_cache_hit_tokens }
      : {}),
    ...(typeof record.prompt_cache_miss_tokens === "number"
      ? { promptCacheMissTokens: record.prompt_cache_miss_tokens }
      : {}),
    ...(promptTokensDetails !== undefined ? { promptTokensDetails } : {}),
    ...(completionTokensDetails !== undefined ? { completionTokensDetails } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ContentBlock is not a discriminated union on `type` (OpaqueBlock.type is
// `string & {}`), so explicit type guards are required for narrowing.
function isReasoningBlock(block: ContentBlock): block is ReasoningBlock {
  return block.type === "reasoning";
}

function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === "image";
}
