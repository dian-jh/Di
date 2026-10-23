import type { ChatModel, ModelRequest } from "../../types/model.ts";
import type { ModelEvent } from "../../types/stream.ts";
import { sseToModelEvents } from "../../sse.ts";
import {
  chatgptDefaults,
  chatgptErrorCodes,
  createChatGptTranslator,
  mapHttpErrorBody,
  serializeRequest,
  toWireRequest,
  ChatGptError,
} from "./translator.ts";

/*
 * ChatGPT Responses {@link ChatModel} adapter. Owns the HTTP/SSE transport and
 * plugs the wire translator into the `TranslateEvent` seam.
 *
 * Auth header and base URL are per-request (never global). The host injects the
 * resolved access token (from the host-side OAuth credential store — @di/ai
 * gains no credential storage) and the fetch implementation (@di/ai is
 * Web-API-only). This adapter throws structured errors but does not retry;
 * RetryingChatModel owns retry/backoff. It does own the response-header wait
 * timeout (default 120s, matching ) and maps fetch-level connection failures
 * to a retryable `CONNECTION` {@link ChatGptError}. The session id, when
 * provided, is hashed into the advisory `prompt_cache_key` (SHA-256 hex).
 */
export interface ChatGptAdapterOptions {
  /** Provider model id actually invoked; carried into request + ModelResponse. */
  readonly model: string;
  /** Resolved ChatGPT access token (host-injected; missing/blank → MISSING_CREDENTIAL). */
  readonly apiKey: string;
  /** Base URL; defaults to `https://api.openai.com/v1`. */
  readonly baseUrl?: string;
  /** Injected fetch; defaults to `globalThis.fetch`. */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Idle deadline between SSE frames, forwarded to `sseToModelEvents`. */
  readonly idleTimeoutMs?: number;
  /**
   * Response-header wait deadline in milliseconds (default 120 seconds). A
   * timeout produces a retryable `TIMEOUT`; `<= 0` disables it. This does not
   * limit the response body: `idleTimeoutMs` bounds the gap between SSE frames.
   */
  readonly headerTimeoutMs?: number;
}

export class ChatGptAdapter implements ChatModel {
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly idleTimeoutMs: number | undefined;
  private readonly headerTimeoutMs: number;

  constructor(options: ChatGptAdapterOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? chatgptDefaults.baseUrl;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.headerTimeoutMs = options.headerTimeoutMs ?? chatgptDefaults.requestTimeoutSeconds * 1000;
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    if (this.apiKey.trim() === "") {
      throw new ChatGptError({
        message: "Run di auth chatgpt login and enable ChatGPT plan usage.",
        code: chatgptErrorCodes.missingCredential,
      });
    }

    const promptCacheKey =
      request.sessionId !== undefined && request.sessionId.trim() !== ""
        ? await sha256Hex(request.sessionId)
        : undefined;
    const wire = toWireRequest(request, this.model, promptCacheKey !== undefined ? { promptCacheKey } : undefined);
    const response = await this.fetchWithHeaderTimeout(
      `${this.baseUrl}${chatgptDefaults.responsesPath}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: serializeRequest(wire),
        signal,
      },
      signal,
    );

    if (!response.ok) {
      const bodyText = await safeReadBody(response);
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const requestId = response.headers.get("x-request-id") ?? "unknown";
      throw new ChatGptError(mapHttpErrorBody(response.status, bodyText, requestId, retryAfterMs));
    }

    if (response.body === null) {
      throw new ChatGptError({
        message: "ChatGPT 响应缺少响应体。",
        code: chatgptErrorCodes.badResponse,
        status: response.status,
      });
    }

    yield* sseToModelEvents(response.body, {
      model: this.model,
      translateEvent: createChatGptTranslator(),
      idleTimeoutMs: this.idleTimeoutMs,
      signal,
    });
  }

  /**
   * Wait for response headers under `headerTimeoutMs`. `fetch` resolves when the
   * headers arrive, so this deadline cannot interrupt an already-streaming
   * body. Caller cancellation takes precedence; other fetch failures become
   * retryable `CONNECTION` errors for the retry wrapper.
   */
  private async fetchWithHeaderTimeout(
    url: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    // An already-aborted caller signal must not start a request: abort the linked
    // controller up front (a fresh listener would never observe the past event).
    if (signal?.aborted) {
      controller.abort();
    }
    const headerTimer = this.headerTimeoutMs > 0
      ? setTimeout(() => controller.abort(), this.headerTimeoutMs)
      : undefined;
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      // Caller cancellation always wins over the header timer and is rethrown
      // raw (an AbortError) so the loop can recognize the hard cancel.
      if (signal?.aborted) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new ChatGptError({
          message: `OpenAI response headers timed out (${this.headerTimeoutMs} ms).`,
          code: chatgptErrorCodes.timeout,
        });
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new ChatGptError({
        message: `Cannot connect to OpenAI: ${detail}`,
        code: chatgptErrorCodes.connection,
      });
    } finally {
      if (headerTimer !== undefined) clearTimeout(headerTimer);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

/** Read a non-2xx body without letting a read failure mask the status. */
async function safeReadBody(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

/** Parse a `Retry-After` header into milliseconds (delta-seconds or HTTP-date). */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Hash a session id to lowercase SHA-256 hex with Web Crypto, keeping this
 * package independent of Node-specific I/O. The result is an opaque cache
 * affinity hint; its casing does not affect wire behavior.
 */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
