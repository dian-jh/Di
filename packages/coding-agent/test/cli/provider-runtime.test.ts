import test from "node:test";
import assert from "node:assert/strict";

import { DiConfig } from "../../src/core/config/di-config.ts";
import { createDefaultProviderRuntime } from "../../src/cli/provider-runtime.ts";
import { RetryingChatModel, type ModelRequest } from "@di/ai";

const request: ModelRequest = { messages: [{ role: "user", content: [{ type: "text", text: "synthetic" }] }] };

test("provider runtime resolves DeepSeek defaults, strict tools, and retry wrapper", async () => {
  let body = "";
  let endpoint = "";
  const config = DiConfig.merge({ DeepSeek: { DefaultReasoningEffort: "low", StrictTools: true } }, undefined, undefined, {});
  const runtime = createDefaultProviderRuntime({
    config,
    deepSeekApiKey: "synthetic-key",
    retry: { maxAttempts: 1 },
    deepSeekFetch: async (url, init) => { endpoint = url; body = String(init?.body); throw new Error("synthetic stop"); },
  });
  const model = runtime.createModel("deepseek/deepseek-flash");
  assert.ok(model instanceof RetryingChatModel);
  const withTools = { ...request, tools: [{ name: "synthetic_tool", description: "synthetic", parameters: { type: "object" } }] };
  await assert.rejects(async () => { for await (const _ of model.stream(withTools)) {} }, /synthetic stop/);
  const wire = JSON.parse(body) as { thinking?: { reasoning_effort?: string }; tools?: Array<{ function: { strict?: boolean } }> };
  assert.equal(wire.thinking?.reasoning_effort, "low");
  assert.equal(wire.tools?.[0]?.function.strict, true);
  assert.equal(endpoint, "https://api.deepseek.com/beta/chat/completions");
});

test("DeepSeek runtime passes custom base URL and header timeout to the adapter", async () => {
  const config = DiConfig.merge({ DeepSeek: { BaseUrl: "https://synthetic.invalid/custom", TimeoutSeconds: 0.02, StreamIdleTimeoutSeconds: 0 } }, undefined, undefined, {});
  let endpoint = "";
  let aborted = false;
  const runtime = createDefaultProviderRuntime({
    config,
    deepSeekApiKey: "synthetic-key",
    retry: { maxAttempts: 1 },
    deepSeekFetch: async (url, init) => {
      endpoint = url;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); }, { once: true });
      });
    },
  });
  await assert.rejects(async () => { for await (const _ of runtime.createModel("deepseek/custom-model").stream(request)) {} });
  assert.equal(endpoint, "https://synthetic.invalid/custom/chat/completions");
  assert.equal(aborted, true);
});

test("DeepSeek runtime routes UseSystemProxy through the Windows proxy fetch seam", async () => {
  let endpoint = "";
  const runtime = createDefaultProviderRuntime({
    config: DiConfig.merge({ DeepSeek: { UseSystemProxy: true } }, undefined, undefined, {}),
    deepSeekApiKey: "synthetic-key",
    retry: { maxAttempts: 1 },
    deepSeekSystemProxyFetch: async (url) => { endpoint = url; throw new Error("synthetic stop"); },
  });
  await assert.rejects(async () => { for await (const _ of runtime.createModel("deepseek/deepseek-flash").stream(request)) {} }, /synthetic stop/);
  assert.equal(endpoint, "https://api.deepseek.com/chat/completions");
});

test("DeepSeek UseSystemProxy on POSIX routes through environment proxy handling", async () => {
  const runtime = createDefaultProviderRuntime({
    config: DiConfig.merge({ DeepSeek: { UseSystemProxy: true } }, undefined, undefined, {}),
    deepSeekApiKey: "synthetic-key",
    retry: { maxAttempts: 1 },
    platform: "linux",
    environment: { HTTPS_PROXY: "http://[invalid" },
  });
  await assert.rejects(async () => { for await (const _ of runtime.createModel("deepseek/deepseek-flash").stream(request)) {} }, /environment proxy endpoint is invalid/);
});

test("ChatGPT model requests use POSIX environment proxy handling", async () => {
  const runtime = createDefaultProviderRuntime({
    config: DiConfig.merge({}, undefined, undefined, {}),
    chatGptAuth: { accessToken: async () => "synthetic-access-token" } as never,
    retry: { maxAttempts: 1 },
    platform: "linux",
    environment: { HTTPS_PROXY: "http://[invalid" },
  });
  await assert.rejects(async () => { for await (const _ of runtime.createModel("chatgpt/gpt-6.1-sol").stream(request)) {} }, /environment proxy endpoint is invalid/);
});

test("ChatGPT model obtains a synthetic access token per call and is retry wrapped", async () => {
  const config = DiConfig.merge({}, undefined, undefined, {});
  let tokenCalls = 0;
  let authorization = "";
  let body = "";
  const auth = { accessToken: async () => { tokenCalls++; return "synthetic-access-token"; } } as never;
  const runtime = createDefaultProviderRuntime({
    config,
    chatGptAuth: auth,
    retry: { maxAttempts: 1 },
    chatGptFetch: async (_url, init) => { authorization = new Headers(init?.headers).get("authorization") ?? ""; body = String(init?.body); throw new Error("synthetic stop"); },
  });
  const model = runtime.createModel("chatgpt/gpt-6.1-sol");
  assert.ok(model instanceof RetryingChatModel);
  await assert.rejects(async () => { for await (const _ of model.stream(request)) {} }, /synthetic stop/);
  assert.equal(tokenCalls, 1);
  assert.equal(authorization, "Bearer synthetic-access-token");
  assert.equal(JSON.parse(body).reasoning.effort, "medium");
});
