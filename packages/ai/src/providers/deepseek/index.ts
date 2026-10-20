/**
 * DeepSeek provider adapter public surface (P3.3 request/response translation).
 * Wire DTOs and quirks stay inside this provider module; only the adapter pieces
 * are exported for `@di/ai` consumers.
 */

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
} from "./translator.ts";

export { DeepSeekAdapter } from "./adapter.ts";
export type { DeepSeekAdapterOptions } from "./adapter.ts";

export type {
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
  DeepSeekWirePromptTokensDetails,
  DeepSeekWireCompletionTokensDetails,
} from "./wire.ts";
