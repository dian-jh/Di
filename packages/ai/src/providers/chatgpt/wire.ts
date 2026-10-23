/*
 * ChatGPT Responses wire DTOs.
 *
 * These provider-internal transport objects are translated into the shared
 * vocabulary in `src/types/*`. Request fields are serialized in declared order;
 * unset values are omitted, and the fixed stateless settings (`store:false`,
 * `stream:true`, no `previous_response_id`) keep the request prefix stable.
 */

/** Streaming Responses request body. Field order is fixed by `serializeRequest`. */
export interface ChatGptWireRequest {
  readonly model: string;
  readonly input: readonly ChatGptWireInputItem[];
  readonly store: boolean;
  readonly stream: boolean;
  readonly include: readonly string[];
  /** SHA-256 hex of the session id; advisory cache-affinity key. */
  readonly promptCacheKey?: string;
  readonly reasoning?: ChatGptWireReasoning;
  readonly tools?: readonly ChatGptWireToolNamespace[];
  readonly toolChoice?: string;
}

export interface ChatGptWireReasoning {
  readonly effort: string;
  readonly summary: string;
}

export interface ChatGptWireToolNamespace {
  readonly type: "namespace";
  readonly name: "di";
  readonly description: string;
  readonly tools: readonly ChatGptWireTool[];
}

export interface ChatGptWireTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict: boolean;
}

/*
 * One Responses `input` item. Conversation turns use `role` (developer/user/
 * assistant); function call protocol items use `type`. Replayed raw output items
 * (message/reasoning/…) stay verbatim through the catch-all member — never
 * reshaped or re-serialized field-by-field (models-and-auth.md §Responses wire).
 */
export type ChatGptWireInputItem =
  | { readonly role: "developer"; readonly content: string }
  | { readonly role: "user"; readonly content: readonly ChatGptWireUserContentPart[] }
  | { readonly role: "assistant"; readonly content: readonly ChatGptWireAssistantContentPart[] }
  | { readonly type: "function_call"; readonly call_id: string; readonly name: string; readonly namespace: string; readonly arguments: string }
  | { readonly type: "function_call_output"; readonly call_id: string; readonly output: string }
  | { readonly type: string & {}; readonly [key: string]: unknown };

export type ChatGptWireUserContentPart =
  | { readonly type: "input_text"; readonly text: string }
  | { readonly type: "input_image"; readonly image_url: string; readonly detail: string }
  | { readonly type: "input_file"; readonly file_data: string; readonly filename: string };

export type ChatGptWireAssistantContentPart = { readonly type: "output_text"; readonly text: string };

// ---------------------------------------------------------------------------
// Responses SSE event DTOs (unknown JSON → typed at the provider boundary)
// ---------------------------------------------------------------------------

export interface ChatGptWireSseEvent {
  readonly type?: string;
  readonly output_index?: number;
  readonly content_index?: number;
  readonly delta?: string;
  readonly response?: ChatGptWireResponse;
  /** Item kept as the raw record so `output_item.done` replay is lossless. */
  readonly item?: Readonly<Record<string, unknown>>;
  readonly error?: Readonly<Record<string, unknown>>;
  readonly message?: string;
  readonly code?: string;
  readonly reason?: string;
}

export interface ChatGptWireResponse {
  readonly id?: string;
  /** Original `response.output` — preserved verbatim for opaque replay. */
  readonly output?: readonly unknown[];
  readonly usage?: ChatGptWireUsage;
  readonly error?: Readonly<Record<string, unknown>>;
  readonly incomplete_details?: Readonly<Record<string, unknown>>;
}

export interface ChatGptWireUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly input_tokens_details?: { readonly cached_tokens?: number; readonly cache_write_tokens?: number };
  readonly output_tokens_details?: { readonly reasoning_tokens?: number };
}
