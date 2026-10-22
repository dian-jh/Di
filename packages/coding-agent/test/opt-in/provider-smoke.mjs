/**
 * One-shot, real-provider diagnostic. Never part of the default test suite.
 * Run only with explicit opt-in:
 *   $env:DI_ALLOW_REAL_PROVIDER_SMOKE = '1'; node packages/coding-agent/test/opt-in/provider-smoke.mjs chatgpt
 * It reads ChatGPT credentials through the real CredentialStore (including its
 * native lock); it never prints tokens, headers, prompts, or response content.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { ChatGptAdapter } from "../../../ai/src/providers/chatgpt/adapter.ts";
import { DeepSeekAdapter } from "../../../ai/src/providers/deepseek/adapter.ts";
import { createAclAdapter } from "../../src/core/auth/acl.ts";
import { ChatGptAuth } from "../../src/core/auth/chatgpt-auth.ts";
import { CredentialStore } from "../../src/core/auth/credential-store.ts";
import { DiConfig, DEFAULT_CONFIG, defaultReadFile } from "../../src/core/config/di-config.ts";
import { DiHome } from "../../src/core/config/di-home.ts";
import { NativeOsLockProvider } from "../../src/core/auth/lock-provider.ts";
import { createWindowsSystemProxyFetch } from "../../src/cli/windows-system-proxy.ts";

const selectedProvider = process.argv[2];
if (process.env.DI_ALLOW_REAL_PROVIDER_SMOKE !== "1" || !["chatgpt", "deepseek"].includes(selectedProvider)) {
  console.error("Set DI_ALLOW_REAL_PROVIDER_SMOKE=1 and select exactly one provider: chatgpt or deepseek.");
  process.exitCode = 2;
} else {
  const home = DiHome.fromEnvironment(process.env, homedir());
  const config = await DiConfig.load({
    defaults: DEFAULT_CONFIG,
    userConfigPath: home.configFile,
    projectConfigPath: undefined,
    env: process.env,
  }, { readFile: defaultReadFile });

  if (selectedProvider === "chatgpt") await smokeChatGpt(home);
  else await smokeDeepSeek(config);
}

async function smokeChatGpt(home) {
  const provider = "chatgpt";
  const model = "gpt-6.1-sol";
  let store;
  let beforeCredential;
  let hasBeforeSnapshot = false;
  try {
    const systemFetch = createWindowsSystemProxyFetch();
    store = new CredentialStore({
      lock: new NativeOsLockProvider(),
      acl: createAclAdapter(),
      directory: join(home.rootDirectory, "auth", "chatgpt"),
    });
    const auth = new ChatGptAuth(store, { http: (url, init) => systemFetch(url, init) });
    const status = await auth.status();
    if (!status.signedIn || !status.planEnabled) {
      report({ provider, model, status: "skipped-no-usable-local-credential" });
      return;
    }

    beforeCredential = (await store.read()).credential;
    hasBeforeSnapshot = true;
    // accessToken refreshes only through the real store's OS-locked transaction.
    const token = await auth.accessToken(AbortSignal.timeout(20_000));
    if (token === null) {
      report({ provider, model, status: "skipped-no-valid-access-token" });
      return;
    }
    const adapter = new ChatGptAdapter({ model, apiKey: token, fetch: systemFetch, headerTimeoutMs: 20_000, idleTimeoutMs: 20_000 });
    await requestOnce(provider, model, adapter, {
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly OK." }] }],
      reasoningEffort: "low",
    });
  } catch (error) {
    let credentialChanged;
    if (store !== undefined && hasBeforeSnapshot) {
      try {
        credentialChanged = !sameCredential(beforeCredential, (await store.read()).credential);
      } catch {
        credentialChanged = undefined;
      }
    }
    reportFailure(provider, model, error, credentialChanged);
  }
}

async function smokeDeepSeek(config) {
  const provider = "deepseek";
  const model = "deepseek-flash";
  const apiKey = asString(config.get("deepseek:apikey")) ?? process.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    report({ provider, model, status: "skipped-no-api-key" });
    return;
  }
  const strictTools = isTrue(config.get("deepseek:stricttools"));
  const baseUrl = asString(config.get("deepseek:baseurl")) ??
    (strictTools ? "https://api.deepseek.com/beta" : "https://api.deepseek.com");
  const fetch = isTrue(config.get("deepseek:usesystemproxy"))
    ? createWindowsSystemProxyFetch()
    : undefined;
  const adapter = new DeepSeekAdapter({
    model,
    apiKey,
    baseUrl,
    fetch,
    headerTimeoutMs: 20_000,
    idleTimeoutMs: 20_000,
  });
  await requestOnce(provider, model, adapter, {
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly OK." }] }],
    reasoningEffort: "off",
    maxTokens: 32,
  });
}

async function requestOnce(provider, model, adapter, request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    for await (const event of adapter.stream(request, controller.signal)) {
      if (event.type === "completed") {
        const response = event.response;
        const usage = response.usage;
        report({
          provider,
          model,
          status: response.finishReason.type === "error" ? "provider-error" : "completed",
          finish: response.finishReason.type,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            reasoningTokens: usage.reasoningTokens,
          },
        });
      }
    }
  } catch (error) {
    reportFailure(provider, model, error);
  } finally {
    clearTimeout(timer);
  }
}

function reportFailure(provider, model, error, credentialChanged) {
  const status = error !== null && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
  const errorCode = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  report({ provider, model, status: "request-failed", ...(errorCode === undefined ? {} : { errorCode }), ...(status === undefined ? {} : { httpStatus: status }), ...(credentialChanged === undefined ? {} : { credentialChanged }) });
}

function sameCredential(left, right) {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.clientId === right.clientId && left.accessToken === right.accessToken &&
      left.refreshToken === right.refreshToken && left.idToken === right.idToken && left.expiresAt === right.expiresAt &&
      left.earliestRefreshAt === right.earliestRefreshAt && left.scopes.length === right.scopes.length &&
      left.scopes.every((scope, index) => scope === right.scopes[index]);
}

function report(value) {
  console.log(JSON.stringify(value));
}

function asString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isTrue(value) {
  return value === true || (typeof value === "string" && value.toLowerCase() === "true");
}
