import type { ChatModel, ModelRequest } from "../../types/model.ts";
import type { ModelEvent } from "../../types/stream.ts";
import { sseToModelEvents } from "../../sse.ts";
import {
  createDeepSeekTranslator,
  deepSeekDefaults,
  deepSeekErrorCodes,
  mapHttpErrorBody,
  serializeRequest,
  toWireRequest,
  DeepSeekError,
} from "./translator.ts";

/**
 * DeepSeek {@link ChatModel} adapter (Di baseline
 * `Core/Providers/DeepSeek/DeepSeekAdapter.cs`). Owns the HTTP/SSE transport and
 * plugs the P3.3 wire translator into the P3.2 `TranslateEvent` seam.
 *
 * Auth header and base URL are per-request (never global). The host injects the
 * resolved API key and the fetch implementation (@di/ai is Web-API-only).
 * Retry/backoff lives in the P3.5 {@link RetryingChatModel} wrapper — this
 * adapter throws structured errors but does not retry. It does own the
 * response-header wait timeout (default 60s) and maps fetch-level connection
 * failures to a retryable `CONNECTION` {@link DeepSeekError}.
 */
export interface DeepSeekAdapterOptions {
  /** Provider model id actually invoked; carried into request + ModelResponse. */
  readonly model: string;
  /** Resolved API key (host-injected; missing/blank → MISSING_CREDENTIAL). */
  readonly apiKey: string;
  /** Base URL; defaults to `https://api.deepseek.com`. */
  readonly baseUrl?: string;
  /** Injected fetch; defaults to `globalThis.fetch`. */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Idle deadline between SSE frames, forwarded to `sseToModelEvents`. */
  readonly idleTimeoutMs?: number;
  /**
   * Response-header wait timeout in ms (C# `DeepSeekDefaults.RequestTimeoutSeconds`,
   * default 60s): the server must start responding within this window or the
   * request fails with a retryable `TIMEOUT` {@link DeepSeekError}. `<= 0`
   * disables the timer. This is NOT a total-duration timeout — a long-thinking
   * stream is bounded only by `idleTimeoutMs` between SSE frames.
   */
  readonly headerTimeoutMs?: number;
}

export class DeepSeekAdapter implements ChatModel {
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly idleTimeoutMs: number | undefined;
  private readonly headerTimeoutMs: number;

  constructor(options: DeepSeekAdapterOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? deepSeekDefaults.baseUrl;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.headerTimeoutMs = options.headerTimeoutMs ?? deepSeekDefaults.requestTimeoutSeconds * 1000;
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    if (this.apiKey.trim() === "") {
      throw new DeepSeekError({ message: "DeepSeek 未配置 API Key。", code: deepSeekErrorCodes.missingCredential });
    }

    const wire = toWireRequest(request, this.model);
    const response = await this.fetchWithHeaderTimeout(
      `${this.baseUrl}${deepSeekDefaults.chatCompletionsPath}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
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
      throw new DeepSeekError(mapHttpErrorBody(response.status, bodyText, retryAfterMs));
    }

    if (response.body === null) {
      throw new DeepSeekError({
        message: "DeepSeek 响应缺少响应体。",
        code: deepSeekErrorCodes.badResponse,
        status: response.status,
      });
    }

    yield* sseToModelEvents(response.body, {
      model: this.model,
      translateEvent: createDeepSeekTranslator(),
      idleTimeoutMs: this.idleTimeoutMs,
      signal,
    });
  }

  /**
   * Send the request with a response-header wait timeout (C#
   * `DeepSeekAdapter.SendAsync`). `fetch` settles as soon as the response headers
   * arrive, so a timer that aborts the request is exactly a header-wait timeout —
   * it never touches the (already streaming) body. Caller cancellation always
   * wins over the timer; a fetch-level network failure (connection refused / DNS
   * / reset) maps to a retryable `CONNECTION` {@link DeepSeekError} so the retry
   * wrapper can classify it.
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
        throw new DeepSeekError({
          message: `DeepSeek 响应头等待超时（${this.headerTimeoutMs} ms）。`,
          code: deepSeekErrorCodes.timeout,
        });
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new DeepSeekError({
        message: `无法连接 DeepSeek：${detail}`,
        code: deepSeekErrorCodes.connection,
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
