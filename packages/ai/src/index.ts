/**
 * @di/ai — public entry.
 *
 * Provider-neutral message/model vocabulary. Cross-package consumers must import
 * only these public exports (never `../src`). The ownership table in
 * docs/migration/typescript-core/architecture.md is authoritative.
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

// Usage aggregation and cost computation (P3 card 4: TokenUsage Add/SumOrNull,
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

// DeepSeek provider adapter (P3.3 request/response translation).
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
