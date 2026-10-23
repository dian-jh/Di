/*
 * DeepSeek chat/completions wire DTOs.
 *
 * These provider-internal transport objects are translated into the shared
 * vocabulary in `src/types/*`. Request fields use the provider's snake_case
 * names and declared wire order; unset values are omitted so the prefix remains
 * stable for caching.
 */

/** Streaming request body. Field order on the wire is fixed by `serializeRequest`. */
export interface DeepSeekWireRequest {
  readonly messages: readonly DeepSeekWireMessage[];
  readonly model: string;
  readonly thinking?: DeepSeekWireThinking;
  readonly maxTokens?: number;
  readonly stream: boolean;
  readonly streamOptions: DeepSeekWireStreamOptions;
  readonly tools?: readonly DeepSeekWireTool[];
  readonly toolChoice?: string;
}

export interface DeepSeekWireThinking {
  readonly type: string;
  readonly reasoningEffort?: string;
}

export interface DeepSeekWireStreamOptions {
  readonly includeUsage: boolean;
}

export interface DeepSeekWireMessage {
  readonly role: string;
  readonly content?: string | readonly DeepSeekWireContentPart[];
  readonly reasoningContent?: string;
  readonly toolCalls?: readonly DeepSeekWireToolCall[];
  readonly toolCallId?: string;
}

export interface DeepSeekWireContentPart {
  readonly type: "text" | "image_url";
  readonly text?: string;
  readonly imageUrl?: DeepSeekWireImageUrl;
}

export interface DeepSeekWireImageUrl {
  readonly url: string;
  readonly detail?: string;
}

export interface DeepSeekWireTool {
  readonly type: "function";
  readonly function: DeepSeekWireFunction;
}

export interface DeepSeekWireFunction {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
}

export interface DeepSeekWireToolCall {
  readonly id?: string;
  readonly type?: string;
  readonly index?: number;
  readonly function?: DeepSeekWireFunctionCall;
}

export interface DeepSeekWireFunctionCall {
  readonly name?: string;
  readonly arguments?: string;
}

/** Streaming response chunk (one `data:` SSE line payload). */
export interface DeepSeekWireChunk {
  readonly id?: string;
  readonly choices?: readonly DeepSeekWireChunkChoice[];
  readonly usage?: DeepSeekWireUsage;
}

export interface DeepSeekWireChunkChoice {
  readonly delta?: DeepSeekWireDelta;
  readonly finishReason?: string;
  readonly index?: number;
}

export interface DeepSeekWireDelta {
  readonly content?: string;
  readonly reasoningContent?: string;
  readonly role?: string;
  readonly toolCalls?: readonly DeepSeekWireToolCall[];
}

export interface DeepSeekWireUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens?: number;
  readonly promptCacheHitTokens?: number;
  readonly promptCacheMissTokens?: number;
  readonly promptTokensDetails?: DeepSeekWirePromptTokensDetails;
  readonly completionTokensDetails?: DeepSeekWireCompletionTokensDetails;
}

export interface DeepSeekWirePromptTokensDetails {
  readonly cachedTokens?: number;
}

export interface DeepSeekWireCompletionTokensDetails {
  readonly reasoningTokens?: number;
}
