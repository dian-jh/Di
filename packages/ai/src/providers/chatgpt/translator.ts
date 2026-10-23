import type {
  ContentBlock,
  FileBlock,
  ImageBlock,
  OpaqueBlock,
  ToolCall,
} from "../../types/content.ts";
import { isTextBlock } from "../../types/content.ts";
import type { AgentMessage, AssistantMessage } from "../../types/messages.ts";
import type { FinishReason, LlmFailure, ModelRequest, TokenUsage } from "../../types/model.ts";
import type { ToolSpec } from "../../types/tools.ts";
import type { ProviderChunk } from "../../stream-assembler.ts";
import type { SseEvent, TranslateEvent } from "../../sse.ts";
import type {
  ChatGptWireAssistantContentPart,
  ChatGptWireInputItem,
  ChatGptWireRequest,
  ChatGptWireResponse,
  ChatGptWireSseEvent,
  ChatGptWireTool,
  ChatGptWireToolNamespace,
  ChatGptWireUsage,
  ChatGptWireUserContentPart,
} from "./wire.ts";

/*
 * ChatGPT Responses ↔ unified vocabulary translation.
 *
 * Request side: {@link toWireRequest} maps the internal AgentMessage/ToolSpec
 * history onto the stateless Responses DTO (`store:false`, `stream:true`, full
 * input history, NO `previous_response_id`; system → developer; tools into the
 * Di namespace). Explicitly-unsupported sampling/penalty/max-token/stop options
 * throw `UNSUPPORTED_OPTION` before anything is sent. Terminal `response.output`
 * is preserved as an opaque `chatgpt.output` block and replayed verbatim in
 * later history; legacy histories without raw output follow the * replay path (encrypted `chatgpt.reasoning` items first, then normalized
 * output_text/function_call items — display blocks are never re-sent).
 *
 * Response side: {@link createChatGptTranslator} is a stateful closure plugged
 * into the `TranslateEvent` seam of `sseToModelEvents`. It maps one Responses
 * SSE event onto {@link ProviderChunk}s, keeping each terminal type's own
 * stop/error semantics (completed → stop/tool-calls, failed → error,
 * incomplete → max-tokens/error, error → error) and leaving a missing terminal
 * to `sseToModelEvents` to report as a protocol-truncation connection error —
 * a success finish is never fabricated.
 */

/** ChatGPT Responses protocol constants (from `ChatGptAuth.Resource`). */
export const chatgptDefaults = {
  baseUrl: "https://api.openai.com/v1",
  responsesPath: "/responses",
  /*
 * Maximum wait for response headers, in seconds. Once headers arrive, the body
 * is governed separately by the SSE idle timeout between frames.
 */
  requestTimeoutSeconds: 120,
} as const;

/** Stable, machine-readable error codes. */
export const chatgptErrorCodes = {
  missingCredential: "MISSING_CREDENTIAL",
  unsupportedOption: "UNSUPPORTED_OPTION",
  invalidRequest: "INVALID_REQUEST",
  rateLimited: "RATE_LIMITED",
  timeout: "TIMEOUT",
  connection: "CONNECTION",
  badResponse: "BAD_RESPONSE",
  aborted: "ABORTED",
} as const;

// ---------------------------------------------------------------------------
// Request side
// ---------------------------------------------------------------------------

/*
 * Map a unified {@link ModelRequest} onto the ChatGPT Responses wire DTO.
 * `model` is the provider model id bound to the adapter. Unsupported sampling /
 * penalty / max-token / stop options are rejected before sending; unset fields
 * stay omitted (byte-stable prefix cache).
 */
export function toWireRequest(
  request: ModelRequest,
  model: string,
  options: { readonly promptCacheKey?: string } = {},
): ChatGptWireRequest {
  if (
    request.temperature !== undefined ||
    request.topP !== undefined ||
    request.frequencyPenalty !== undefined ||
    request.presencePenalty !== undefined ||
    request.maxTokens !== undefined ||
    (request.stop !== undefined && request.stop.length > 0)
  ) {
    throw new ChatGptError({
      message: "ChatGPT plan Responses does not support sampling, penalties, max tokens or stop options.",
      code: chatgptErrorCodes.unsupportedOption,
    });
  }

  // "default" means "use the model's default effort" → omit (model-selection
  // strips the explicit override before it reaches the translator).
  const hasTools = request.tools !== undefined && request.tools.length > 0;
  return {
    model,
    input: request.messages.flatMap(toWireInputItems),
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    ...(options.promptCacheKey !== undefined ? { promptCacheKey: options.promptCacheKey } : {}),
    ...(request.reasoningEffort !== undefined && request.reasoningEffort !== "" && request.reasoningEffort !== "default"
      ? { reasoning: { effort: request.reasoningEffort, summary: "auto" } }
      : {}),
    ...(hasTools && request.tools !== undefined
      ? {
          tools: [
            {
              type: "namespace",
              name: "di",
              description: "Di harness tools, executed locally.",
              tools: request.tools.map(toWireTool),
            },
          ],
          // `ChatToolChoice.Auto` is the default; `tool_choice` is sent only with tools.
          toolChoice: "auto",
        }
      : {}),
  };
}

function toWireInputItems(message: AgentMessage): readonly ChatGptWireInputItem[] {
  switch (message.role) {
    case "system":
      return [{ role: "developer", content: message.text }];
    case "user":
      return [{ role: "user", content: toWireUserContent(message.content) }];
    case "assistant":
      return toWireAssistantItems(message);
    case "tool":
      return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
    default: {
      const exhaustive: never = message;
      throw new ChatGptError({
        message: `Unknown message role '${(exhaustive as { role?: string }).role ?? "?"}'.`,
        code: chatgptErrorCodes.invalidRequest,
      });
    }
  }
}

function toWireUserContent(content: readonly ContentBlock[]): readonly ChatGptWireUserContentPart[] {
  const parts: ChatGptWireUserContentPart[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      parts.push({ type: "input_text", text: block.text });
    } else if (isImageBlock(block) && isImageUrl(block.attachmentId)) {
      parts.push({ type: "input_image", image_url: block.attachmentId, detail: block.detail ?? "auto" });
    } else if (isFileBlock(block) && block.attachmentId.startsWith("data:")) {
      parts.push({ type: "input_file", file_data: block.attachmentId, filename: block.filename ?? "attachment" });
    } else {
      throw new ChatGptError({
        message: `Unsupported or unresolved ChatGPT attachment/content block: ${block.type}`,
        code: chatgptErrorCodes.unsupportedOption,
      });
    }
  }
  return parts;
}

function toWireAssistantItems(message: AssistantMessage): readonly ChatGptWireInputItem[] {
  const original = message.content.find((block): block is OpaqueBlock => isOpaqueOfType(block, "chatgpt.output"));
  if (original !== undefined) {
    // Terminal output is preserved verbatim; normalized display blocks are never
    // re-sent (models-and-auth.md §Responses wire 与 SSE).
    const parsed: unknown = parseOpaqueJson(original.rawJson, "chatgpt.output");
    if (!Array.isArray(parsed)) {
      throw new ChatGptError({ message: "Malformed chatgpt.output opaque block.", code: chatgptErrorCodes.invalidRequest });
    }
    return parsed as readonly ChatGptWireInputItem[];
  }

  const items: ChatGptWireInputItem[] = [];
  // Encrypted reasoning must precede calls when replaying stateless responses.
  for (const block of message.content) {
    if (isOpaqueOfType(block, "chatgpt.reasoning")) {
      items.push(parseOpaqueJson(block.rawJson, "chatgpt.reasoning") as ChatGptWireInputItem);
    } else if (isOpaqueBlock(block)) {
      throw new ChatGptError({ message: "Unsupported opaque ChatGPT block.", code: chatgptErrorCodes.unsupportedOption });
    }
  }
  // Normalized display blocks: output_text / function_call only; plain reasoning
  // summaries and opaque blocks are display-only and not replayed.
  for (const block of message.content) {
    if (isTextBlock(block)) {
      items.push({ role: "assistant", content: [toWireAssistantText(block.text)] });
    } else if (isToolCallBlock(block)) {
      items.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        namespace: "di",
        arguments: block.arguments,
      });
    } else if (block.type === "reasoning" || isOpaqueBlock(block)) {
      continue; // display-only summaries and opaque blocks handled above
    } else {
      throw new ChatGptError({
        message: `Unsupported assistant block: ${block.type}`,
        code: chatgptErrorCodes.unsupportedOption,
      });
    }
  }
  return items;
}

function toWireAssistantText(text: string): ChatGptWireAssistantContentPart {
  return { type: "output_text", text };
}

function toWireTool(tool: ToolSpec): ChatGptWireTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: tool.strict === true,
  };
}

function parseOpaqueJson(rawJson: string, blockType: string): unknown {
  try {
    return JSON.parse(rawJson);
  } catch {
    throw new ChatGptError({ message: `Malformed ${blockType} opaque block.`, code: chatgptErrorCodes.invalidRequest });
  }
}

function isImageUrl(value: string): boolean {
  if (value.startsWith("data:image/")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

// ContentBlock is not a discriminated union on `type` (OpaqueBlock.type is
// `string & {}`), so explicit type guards are required for narrowing.
function isOpaqueOfType(block: ContentBlock, opaqueType: string): block is OpaqueBlock {
  return block.type === opaqueType;
}

function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === "image";
}

function isFileBlock(block: ContentBlock): block is FileBlock {
  return block.type === "file";
}

function isToolCallBlock(block: ContentBlock): block is ToolCall {
  return block.type === "tool-call";
}

function isOpaqueBlock(block: ContentBlock): block is OpaqueBlock {
  return (
    block.type !== "text" &&
    block.type !== "reasoning" &&
    block.type !== "image" &&
    block.type !== "file" &&
    block.type !== "tool-call" &&
    block.type !== "tool-result"
  );
}

/**
 * Serialize request fields in their declared wire order. Optional fields are
 * omitted when unset, keeping the JSON prefix stable for cache affinity.
 */
export function serializeRequest(wire: ChatGptWireRequest): string {
  const body: Record<string, unknown> = {
    model: wire.model,
    input: wire.input,
    store: wire.store,
    stream: wire.stream,
    include: wire.include,
  };
  if (wire.promptCacheKey !== undefined) body.prompt_cache_key = wire.promptCacheKey;
  if (wire.reasoning !== undefined) body.reasoning = { effort: wire.reasoning.effort, summary: wire.reasoning.summary };
  if (wire.tools !== undefined) body.tools = wire.tools.map(serializeToolNamespace);
  if (wire.toolChoice !== undefined) body.tool_choice = wire.toolChoice;
  return JSON.stringify(body);
}

function serializeToolNamespace(namespace: ChatGptWireToolNamespace): Record<string, unknown> {
  return {
    type: namespace.type,
    name: namespace.name,
    description: namespace.description,
    tools: namespace.tools.map((tool) => ({
      type: tool.type,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    })),
  };
}

// ---------------------------------------------------------------------------
// Response side (SSE event → ProviderChunk)
// ---------------------------------------------------------------------------

/**
 * Create the ChatGPT Responses SSE event → {@link ProviderChunk} translator for
 * one stream. Stateful (blocks open across events) and plugs into the P3.2
 * `TranslateEvent` seam of `sseToModelEvents`.
 *
 * Indices are assigned in first-seen order: one block accumulates text and
 * refusal deltas, one accumulates reasoning-summary deltas, and each function
 * call gets a block keyed by `output_index`. At a terminal event, the translator
 * closes those blocks, appends the full output (or preserved reasoning items)
 * as opaque content, then emits usage and the finish reason.
 */
export function createChatGptTranslator(): TranslateEvent {
  let responseIdEmitted = false;
  let toolCalls = false;
  let nextIndex = 0;
  let reasoningIndex: number | undefined;
  let textIndex: number | undefined;
  const callIndices = new Map<number, number>();
  const calls = new Map<number, { id: string; name: string }>();
  const reasoningItems: Array<{ json: string }> = [];

  return (event: SseEvent): readonly ProviderChunk[] => {
    if (event.data === "[DONE]") return [];
    const payload = parseSseEvent(event.data);
    const out: ProviderChunk[] = [];
    const type = payload.type;
    if (type === undefined) return out;

    switch (type) {
      case "response.created": {
        const id = payload.response?.id;
        if (!responseIdEmitted && id !== undefined) {
          responseIdEmitted = true;
          out.push({ type: "responseInfo", responseId: id });
        }
        return out;
      }
      case "response.output_text.delta":
      case "response.refusal.delta": {
        const delta = requireDelta(payload, type);
        if (textIndex === undefined) {
          textIndex = nextIndex++;
          out.push({ type: "blockStart", index: textIndex, block: { type: "text" } });
        }
        out.push({ type: "textDelta", index: textIndex, delta });
        return out;
      }
      case "response.reasoning_summary_text.delta": {
        const delta = requireDelta(payload, type);
        if (reasoningIndex === undefined) {
          reasoningIndex = nextIndex++;
          out.push({ type: "blockStart", index: reasoningIndex, block: { type: "reasoning" } });
        }
        out.push({ type: "reasoningDelta", index: reasoningIndex, delta });
        return out;
      }
      case "response.output_item.added": {
        const item = payload.item;
        if (item?.type === "function_call") {
          const id = typeof item.call_id === "string" ? item.call_id : "";
          const name = typeof item.name === "string" ? item.name : "";
          calls.set(payload.output_index ?? 0, { id, name });
          toolCalls = true;
          const index = ensureCallBlock(out, payload.output_index ?? 0);
          out.push({
            type: "toolCallDelta",
            index,
            id,
            name,
            argumentsDelta: typeof item.arguments === "string" ? item.arguments : "",
          });
        }
        return out;
      }
      case "response.function_call_arguments.delta": {
        const delta = requireDelta(payload, type);
        const outputIndex = payload.output_index ?? 0;
        const call = calls.get(outputIndex);
        const index = callIndices.get(outputIndex);
        if (call === undefined || index === undefined) {
          throw new ChatGptError({
            message: "Tool arguments arrived before function call.",
            code: chatgptErrorCodes.badResponse,
          });
        }
        out.push({ type: "toolCallDelta", index, id: call.id, name: call.name, argumentsDelta: delta });
        return out;
      }
      case "response.output_item.done": {
        const item = payload.item;
        if (item?.type === "reasoning") {
          // Preserve the full encrypted-reasoning item verbatim for later replay.
          reasoningItems.push({ json: JSON.stringify(item) });
        }
        return out;
      }
      case "response.completed":
      case "response.failed":
      case "response.incomplete": {
        const result = payload.response;
        closeContentBlocks(out);
        if (result?.output !== undefined && Array.isArray(result.output)) {
          const index = nextIndex++;
          out.push({
            type: "blockStart",
            index,
            block: { type: "opaque", blockType: "chatgpt.output", rawJson: JSON.stringify(result.output) },
          });
          out.push({ type: "blockEnd", index });
        } else {
          for (const item of reasoningItems) {
            const index = nextIndex++;
            out.push({
              type: "blockStart",
              index,
              block: { type: "opaque", blockType: "chatgpt.reasoning", rawJson: item.json },
            });
            out.push({ type: "blockEnd", index });
          }
        }
        if (result?.usage !== undefined) {
          out.push({ type: "usage", usage: mapUsage(result.usage) });
        }
        out.push({ type: "finish", reason: mapTerminalFinish(type, result, toolCalls) });
        return out;
      }
      case "error": {
        // Close accumulated content before reporting the in-band error finish.
        closeContentBlocks(out);
        out.push({ type: "finish", reason: { type: "error", failure: failureOf(payload) } });
        return out;
      }
      default:
        return out;
    }
  };

  function ensureCallBlock(out: ProviderChunk[], outputIndex: number): number {
    let index = callIndices.get(outputIndex);
    if (index === undefined) {
      index = nextIndex++;
      callIndices.set(outputIndex, index);
      out.push({ type: "blockStart", index, block: { type: "tool-call" } });
    }
    return index;
  }

  function closeContentBlocks(out: ProviderChunk[]): void {
    if (reasoningIndex !== undefined) out.push({ type: "blockEnd", index: reasoningIndex });
    if (textIndex !== undefined) out.push({ type: "blockEnd", index: textIndex });
    for (const index of callIndices.values()) out.push({ type: "blockEnd", index });
  }
}

function requireDelta(payload: ChatGptWireSseEvent, type: string): string {
  if (typeof payload.delta !== "string") {
    throw new ChatGptError({ message: `Missing delta in ${type} event.`, code: chatgptErrorCodes.badResponse });
  }
  return payload.delta;
}

function mapTerminalFinish(type: string, result: ChatGptWireResponse | undefined, toolCalls: boolean): FinishReason {
  switch (type) {
    case "response.failed":
      return { type: "error", failure: failureOf(result?.error) };
    case "response.incomplete":
      if (result?.incomplete_details?.reason === "max_output_tokens") {
        return { type: "max-tokens" };
      }
      return { type: "error", failure: failureOf(result?.incomplete_details) };
    default:
      return toolCalls ? { type: "tool-calls" } : { type: "stop" };
  }
}

/**
 * Map wire usage onto {@link TokenUsage}. Missing input, output, and cached
 * counts default to zero; cache-write, total, and reasoning counts stay optional.
 * Input tokens exclude cached and written counts, with a zero floor.
 */
export function mapUsage(usage: ChatGptWireUsage): TokenUsage {
  const inputTokens = usage.input_tokens ?? 0;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const written = usage.input_tokens_details?.cache_write_tokens;
  return {
    inputTokens: Math.max(0, inputTokens - cached - (written ?? 0)),
    outputTokens: usage.output_tokens ?? 0,
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    cacheReadTokens: cached,
    ...(written !== undefined ? { cacheWriteTokens: written } : {}),
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens }
      : {}),
  };
}

/** Build an {@link LlmFailure} from a provider error or incomplete-details record. */
function failureOf(error: unknown): LlmFailure {
  if (isRecord(error)) {
    return {
      message: typeof error.message === "string" ? error.message : JSON.stringify(error),
      code:
        typeof error.code === "string"
          ? error.code
          : typeof error.reason === "string"
            ? error.reason
            : chatgptErrorCodes.badResponse,
    };
  }
  return { message: "ChatGPT response failed.", code: chatgptErrorCodes.badResponse };
}

// ---------------------------------------------------------------------------
// SSE event parsing (unknown JSON → typed DTO at the provider boundary)
// ---------------------------------------------------------------------------

/** Parse and structurally validate one SSE data line; throws on malformed JSON. */
function parseSseEvent(data: string): ChatGptWireSseEvent {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new ChatGptError({ message: "Malformed ChatGPT SSE event.", code: chatgptErrorCodes.badResponse });
  }
  if (!isRecord(value)) {
    throw new ChatGptError({ message: "Malformed ChatGPT SSE event.", code: chatgptErrorCodes.badResponse });
  }
  return {
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(typeof value.output_index === "number" ? { output_index: value.output_index } : {}),
    ...(typeof value.content_index === "number" ? { content_index: value.content_index } : {}),
    ...(typeof value.delta === "string" ? { delta: value.delta } : {}),
    ...(isRecord(value.response) ? { response: parseResponse(value.response) } : {}),
    ...(isRecord(value.item) ? { item: value.item } : {}),
    ...(isRecord(value.error) ? { error: value.error } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

function parseResponse(record: Record<string, unknown>): ChatGptWireResponse {
  return {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(Array.isArray(record.output) ? { output: record.output as readonly unknown[] } : {}),
    ...(isRecord(record.usage) ? { usage: parseUsage(record.usage) } : {}),
    ...(isRecord(record.error) ? { error: record.error } : {}),
    ...(isRecord(record.incomplete_details) ? { incomplete_details: record.incomplete_details } : {}),
  };
}

function parseUsage(record: Record<string, unknown>): ChatGptWireUsage {
  const inputDetails = isRecord(record.input_tokens_details) ? record.input_tokens_details : undefined;
  const outputDetails = isRecord(record.output_tokens_details) ? record.output_tokens_details : undefined;
  return {
    ...(typeof record.input_tokens === "number" ? { input_tokens: record.input_tokens } : {}),
    ...(typeof record.output_tokens === "number" ? { output_tokens: record.output_tokens } : {}),
    ...(typeof record.total_tokens === "number" ? { total_tokens: record.total_tokens } : {}),
    ...(inputDetails !== undefined
      ? {
          input_tokens_details: {
            ...(typeof inputDetails.cached_tokens === "number"
              ? { cached_tokens: inputDetails.cached_tokens }
              : {}),
            ...(typeof inputDetails.cache_write_tokens === "number"
              ? { cache_write_tokens: inputDetails.cache_write_tokens }
              : {}),
          },
        }
      : {}),
    ...(outputDetails !== undefined && typeof outputDetails.reasoning_tokens === "number"
      ? { output_tokens_details: { reasoning_tokens: outputDetails.reasoning_tokens } }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Non-2xx error mapping
// ---------------------------------------------------------------------------

/**
 * Map a non-2xx HTTP response to a structured {@link LlmFailure}. The message
 * retains the status, request id, and raw body; `error.code` is used when
 * present, otherwise the code is `INVALID_REQUEST`. Status and Retry-After are
 * preserved for provider-neutral retry classification.
 */
export function mapHttpErrorBody(
  status: number,
  body: string | undefined,
  requestId: string,
  providerRetryAfterMs?: number,
): LlmFailure {
  let code: string = chatgptErrorCodes.invalidRequest;
  if (body !== undefined && body.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (isRecord(parsed)) {
        const error = parsed.error;
        if (isRecord(error) && typeof error.code === "string") code = error.code;
      }
    } catch {
      // Body is not JSON — keep INVALID_REQUEST.
    }
  }
  return {
    message: `OpenAI HTTP ${status}, request_id=${requestId}: ${body ?? ""}`,
    code,
    ...(status !== undefined ? { status } : {}),
    ...(providerRetryAfterMs !== undefined ? { providerRetryAfterMs } : {}),
    ...(requestId !== undefined && requestId !== "unknown" ? { requestId } : {}),
  };
}

/**
 * Structured pre-flight / HTTP / in-band protocol error thrown by the ChatGPT
 * adapter and translator. Carries the {@link LlmFailure} fact plus convenience
 * accessors for the retry policy (P3.5). Distinct from `SseStreamError`
 * (transport/protocol failures thrown by `sseToModelEvents`).
 */
export class ChatGptError extends Error {
  readonly failure: LlmFailure;

  constructor(failure: LlmFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "ChatGptError";
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
