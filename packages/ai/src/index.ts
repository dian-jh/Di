/*
 * @di/ai — public entry.
 *
 * Provider-neutral message/model vocabulary. Cross-package consumers must import
 * only these public exports (never `../src`). The ownership table in
 *
 */

export type {
  TextBlock,
  ReasoningBlock,
  ImageBlock,
  FileBlock,
  ToolCall,
  ToolResultBlock,
  OpaqueBlock,
  ContentBlock,
} from "./types/content.ts";
export { isTextBlock } from "./types/content.ts";

export type {
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  AgentMessage,
} from "./types/messages.ts";
export { textOfMessage } from "./types/messages.ts";

export type { ToolSpec } from "./types/tools.ts";

export type { ModelEvent } from "./types/stream.ts";

export type {
  TokenUsage,
  UsageCost,
  LlmFailure,
  FinishReason,
  ModelRef,
  ModelRequest,
  ModelResponse,
  ChatModel,
} from "./types/model.ts";

// Usage aggregation and cost computation ( TokenUsage Add/SumOrNull,
// per-provider catalog rates, unknown cost stays absent — never fabricated zero).
export type { ModelCostRates } from "./usage.ts";
export {
  tokenUsageZero,
  tokenUsageAdd,
  billableInputTokens,
  cacheHitRate,
  usageCostZero,
  usageCostTotal,
  usageCostAdd,
  combineCost,
  calculateCost,
  costForModel,
} from "./usage.ts";
export type { ModelSpec } from "./catalog.ts";
export { MODEL_CATALOG, findModelCostRates } from "./catalog.ts";

export type {
  ProviderBlockStart,
  ProviderChunk,
  ProviderStreamAssemblerOptions,
} from "./stream-assembler.ts";
export { AssemblerError, ProviderStreamAssembler } from "./stream-assembler.ts";

export type {
  SseEvent,
  ParseSseStreamOptions,
  SseToModelEventsOptions,
  TranslateEvent,
} from "./sse.ts";
export { SseEventParser, SseStreamError, parseSseStream, sseToModelEvents } from "./sse.ts";

// Retry/timeout policy ( bounded retry, Retry-After, header-wait and
// SSE idle timeouts, first-ModelEvent retry boundary, cancellation never retries).
export type { RetryPolicyOptions, RetrySleep } from "./retry/index.ts";
export {
  RETRY_DEFAULTS,
  resolveRetryOptions,
  isRetryableFailure,
  isRetryableError,
  failureOf,
  retryDelayMs,
  RetryingChatModel,
  defaultRetrySleep,
} from "./retry/index.ts";

// DeepSeek provider adapter ( request/response translation).
export {
  deepSeekDefaults,
  deepSeekErrorCodes,
  createDeepSeekTranslator,
  mapFinishReason,
  mapHttpErrorBody,
  mapUsage,
  serializeRequest,
  toWireRequest,
  DeepSeekError,
  DeepSeekAdapter,
} from "./providers/deepseek/index.ts";
export type {
  DeepSeekAdapterOptions,
  DeepSeekWireRequest,
  DeepSeekWireThinking,
  DeepSeekWireStreamOptions,
  DeepSeekWireMessage,
  DeepSeekWireContentPart,
  DeepSeekWireImageUrl,
  DeepSeekWireTool,
  DeepSeekWireFunction,
  DeepSeekWireToolCall,
  DeepSeekWireFunctionCall,
  DeepSeekWireChunk,
  DeepSeekWireChunkChoice,
  DeepSeekWireDelta,
  DeepSeekWireUsage,
} from "./providers/deepseek/index.ts";

// ChatGPT Responses provider adapter ( request/response translation). The
// module-internal `toWireRequest` / `serializeRequest` / `mapHttpErrorBody`
// names are re-exported under provider-scoped aliases to avoid colliding with
// the DeepSeek exports above.
export {
  chatgptDefaults,
  chatgptErrorCodes,
  createChatGptTranslator,
  toWireRequest as toChatGptWireRequest,
  serializeRequest as serializeChatGptRequest,
  mapHttpErrorBody as mapChatGptHttpErrorBody,
  ChatGptError,
  ChatGptAdapter,
} from "./providers/chatgpt/index.ts";
export type { ChatGptAdapterOptions } from "./providers/chatgpt/index.ts";
export type {
  ChatGptWireRequest,
  ChatGptWireInputItem,
  ChatGptWireReasoning,
  ChatGptWireToolNamespace,
  ChatGptWireTool,
  ChatGptWireUserContentPart,
  ChatGptWireAssistantContentPart,
  ChatGptWireSseEvent,
  ChatGptWireResponse,
  ChatGptWireUsage,
} from "./providers/chatgpt/index.ts";
