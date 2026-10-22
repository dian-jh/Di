import { ChatGptAdapter, DeepSeekAdapter, MODEL_CATALOG, RetryingChatModel, type ChatModel, type ModelRequest, type ModelEvent, type RetryPolicyOptions } from "@di/ai";
import type { DiConfig } from "../core/config/di-config.ts";
import type { ChatGptAuth } from "../core/auth/chatgpt-auth.ts";
import { ModelReference } from "../core/model-selection.ts";
import { createSystemProxyFetch, createWindowsSystemProxyFetch } from "./windows-system-proxy.ts";

export interface DefaultProviderRuntimeOptions {
  readonly config: DiConfig;
  readonly chatGptAuth?: Pick<ChatGptAuth, "accessToken">;
  readonly deepSeekApiKey?: string;
  readonly retry?: RetryPolicyOptions;
  readonly deepSeekFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly deepSeekSystemProxyFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly chatGptFetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Production provider routing for the host composition root. */
export function createDefaultProviderRuntime(options: DefaultProviderRuntimeOptions): { createModel(label: string, defaultProvider?: string): ChatModel } {
  return {
    createModel(label, defaultProvider = "deepseek") {
      const reference = ModelReference.parse(label, defaultProvider, Object.keys(MODEL_CATALOG));
      if (reference.provider === "deepseek") {
        const strictTools = isTrue(options.config.get("deepseek:stricttools"));
        const systemProxy = isTrue(options.config.get("deepseek:usesystemproxy"));
        const proxyFetch = systemProxy
          ? options.deepSeekSystemProxyFetch ?? createWindowsSystemProxyFetch()
          : undefined;
        if (systemProxy && options.deepSeekSystemProxyFetch === undefined && process.platform !== "win32") {
          throw new Error("DeepSeek:UseSystemProxy static Windows settings are available only on Windows.");
        }
        const configuredBaseUrl = asString(options.config.get("deepseek:baseurl"));
        const model = new DeepSeekAdapter({
          model: reference.id,
          apiKey: options.deepSeekApiKey ?? asString(options.config.get("deepseek:apikey")) ?? process.env.DEEPSEEK_API_KEY ?? "",
          baseUrl: configuredBaseUrl ?? (strictTools ? "https://api.deepseek.com/beta" : "https://api.deepseek.com"),
          headerTimeoutMs: secondsToMs(options.config.get("deepseek:timeoutseconds"), 60),
          idleTimeoutMs: secondsToMs(options.config.get("deepseek:streamidletimeoutseconds"), 60),
          fetch: systemProxy ? proxyFetch : options.deepSeekFetch,
        });
        const effort = asString(options.config.get("deepseek:defaultreasoningeffort"));
        return new RetryingChatModel(withRequestDefaults(model, (request) => ({
          ...request,
          ...(request.reasoningEffort === undefined && effort !== undefined ? { reasoningEffort: effort } : {}),
          ...(strictTools && request.tools !== undefined ? { tools: request.tools.map((tool) => ({ ...tool, strict: true })) } : {}),
        })), options.retry);
      }
      if (reference.provider === "chatgpt") {
        const auth = options.chatGptAuth;
        if (auth === undefined) throw new Error("ChatGPT auth client is unavailable.");
        const catalogDefault = MODEL_CATALOG.chatgpt?.find((entry) => entry.id === reference.id)?.reasoning?.defaultEffort;
        const model: ChatModel = {
          async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
            const token = await auth.accessToken(signal);
            const adapter = new ChatGptAdapter({ model: reference.id, apiKey: token ?? "", fetch: options.chatGptFetch ?? createSystemProxyFetch() });
            yield* adapter.stream(request, signal);
          },
        };
        return new RetryingChatModel(withRequestDefaults(model, (request) => ({
          ...request,
          ...(request.reasoningEffort === undefined && catalogDefault !== undefined ? { reasoningEffort: catalogDefault } : {}),
        })), options.retry);
      }
      throw new Error(`Unknown provider: ${reference.provider}`);
    },
  };
}

function withRequestDefaults(inner: ChatModel, transform: (request: ModelRequest) => ModelRequest): ChatModel {
  return {
    stream(request, signal) { return inner.stream(transform(request), signal); },
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isTrue(value: unknown): boolean { return value === true || (typeof value === "string" && value.toLowerCase() === "true"); }

function secondsToMs(value: unknown, fallback: number): number {
  const seconds = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : fallback;
  return Number.isFinite(seconds) ? seconds * 1000 : fallback * 1000;
}
