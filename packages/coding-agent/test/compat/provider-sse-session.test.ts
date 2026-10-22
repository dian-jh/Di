import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeepSeekAdapter } from "@di/ai";
import { DiHome, createCliHost, createFileTools, loadRecovery, StringTextWriter } from "@di/coding-agent";
import type { ModelInfo, ModelService, ProviderInfo, ResolvedModelInfo } from "@di/coding-agent";
import { createDefaultProviderRuntime } from "../../src/cli/provider-runtime.ts";
import { DiConfig } from "../../src/core/config/di-config.ts";
import { makeArgs } from "../modes/test-host.ts";

function writeSse(res: ServerResponse, chunks: readonly string[]): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const chunk of chunks) res.write(`data: ${chunk}\n\n`);
  res.end("data: [DONE]\n\n");
}

function writeResponsesSse(res: ServerResponse, chunks: readonly string[]): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const chunk of chunks) res.write(`data: ${chunk}\n\n`);
  res.end();
}

function readRequest(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

class LocalCatalog implements ModelService {
  private readonly provider: string;
  private readonly model: string;
  constructor(provider = "deepseek", model = "deepseek-flash") {
    this.provider = provider;
    this.model = model;
  }
  listProviders(): readonly ProviderInfo[] { return [{ id: this.provider, name: this.provider }]; }
  listModels(): readonly ModelInfo[] { return [{ provider: this.provider, id: this.model, name: this.model }]; }
  async refreshModels(): Promise<readonly ModelInfo[]> { return this.listModels(); }
  async checkAuth(): Promise<boolean> { return true; }
  async resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> { return { provider, id, name: id }; }
}

const chatGptToolChunks = [
  '{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"read-1","namespace":"di","name":"read_file","arguments":""}}',
  '{"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"path\\":\\"input.txt\\"}"}',
  '{"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}}',
];

function chatGptRuntime(endpoint: string, authState: { calls: number }, requests: Array<{ url: string; authorization: string; body: unknown }>) {
  return createDefaultProviderRuntime({
    config: DiConfig.merge({}, undefined, undefined, {}),
    chatGptAuth: { accessToken: async () => { authState.calls++; return "synthetic-loopback-token"; } },
    retry: { maxAttempts: 1 },
    chatGptFetch: async (url, init) => {
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? "", body: JSON.parse(String(init?.body)) });
      return await fetch(endpoint, init);
    },
  });
}

test("local DeepSeek SSE adapter runs through host loop and persists recoverable session", async () => {
  const temp = mkdtempSync(join(tmpdir(), "di-sse-session-"));
  const home = join(temp, "home");
  const workspace = join(temp, "workspace");
  const requestBodies: unknown[] = [];
  let requestCount = 0;
  const server = createServer(async (req, res) => {
    const body = await readRequest(req);
    requestBodies.push(JSON.parse(body));
    requestCount++;
    if (requestCount === 1) {
      writeSse(res, [
        '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"read-1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"input.txt\\"}"}}]},"finish_reason":null}]}',
        '{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      ]);
    } else {
      writeSse(res, [
        '{"choices":[{"index":0,"delta":{"content":"Read: hello from fixture"},"finish_reason":null}]}',
        '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      ]);
    }
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}`;
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "input.txt"), "hello from fixture\n");

    const host = await createCliHost(makeArgs({ model: "deepseek-flash" }), workspace, new StringTextWriter(), true, {
      diHome: DiHome.fromDirectory(home),
      modelFactory: () => new DeepSeekAdapter({ model: "deepseek-flash", apiKey: "synthetic-test-key", baseUrl: endpoint }),
      modelService: new LocalCatalog(),
      tools: createFileTools(workspace),
      skills: [],
    });
    const result = await host.runner.runTurn("Read input.txt and report its contents.");
    const logFilePath = host.sessionStore?.logFilePath;
    assert.ok(logFilePath, "host must persist a session log");
    await host.dispose?.();

    assert.equal(requestCount, 2);
    assert.match(result.answer, /hello from fixture/);
    assert.deepEqual(JSON.parse(readFileSync(logFilePath, "utf8").trim().split("\n").at(-1)!).type, "checkpoint_turn_completed");
    const recovered = loadRecovery(logFilePath);
    assert.equal(recovered.find((message) => message.role === "user")?.role, "user");
    assert.equal(recovered.at(-1)?.role, "assistant");
    assert.match(JSON.stringify(recovered), /hello from fixture/);
    assert.match(JSON.stringify(requestBodies[1]), /read_file/);
    assert.match(JSON.stringify(requestBodies[1]), /hello from fixture/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true });
  }
});

test("ChatGPT provider factory sends synthetic auth to local Responses SSE and persists the tool round trip", async () => {
  const temp = mkdtempSync(join(tmpdir(), "di-chatgpt-sse-session-"));
  const home = join(temp, "home");
  const workspace = join(temp, "workspace");
  const requests: Array<{ url: string; authorization: string; body: unknown }> = [];
  const authState = { calls: 0 };
  let requestCount = 0;
  const server = createServer(async (req, res) => {
    await readRequest(req);
    requestCount++;
    if (requestCount === 1) {
      writeResponsesSse(res, chatGptToolChunks);
    } else {
      writeResponsesSse(res, [
        '{"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Read: hello from fixture"}',
        '{"type":"response.completed","response":{"usage":{"input_tokens":16,"output_tokens":6,"total_tokens":22}}}',
      ]);
    }
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}`;
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "input.txt"), "hello from fixture\n");
    const runtime = chatGptRuntime(endpoint, authState, requests);
    const host = await createCliHost(makeArgs({ model: "chatgpt/gpt-6.1-sol" }), workspace, new StringTextWriter(), true, {
      diHome: DiHome.fromDirectory(home),
      modelFactory: () => runtime.createModel("chatgpt/gpt-6.1-sol"),
      modelService: new LocalCatalog("chatgpt", "gpt-6.1-sol"),
      tools: createFileTools(workspace),
      skills: [],
    });
    const result = await host.runner.runTurn("Read input.txt and report its contents.");
    const logFilePath = host.sessionStore?.logFilePath;
    assert.ok(logFilePath, "host must persist a session log");
    await host.dispose?.();

    assert.equal(requestCount, 2);
    assert.equal(authState.calls, 2, "factory must obtain the synthetic access token for both requests");
    assert.ok(requests.every((request) => request.url === "https://api.openai.com/v1/responses"));
    assert.ok(requests.every((request) => request.authorization === "Bearer synthetic-loopback-token"));
    assert.match(result.answer, /hello from fixture/);
    assert.match(JSON.stringify(requests[1]?.body), /function_call_output/);
    assert.match(JSON.stringify(requests[1]?.body), /hello from fixture/);
    const recovered = loadRecovery(logFilePath);
    assert.equal(recovered.find((message) => message.role === "user")?.role, "user");
    assert.equal(recovered.at(-1)?.role, "assistant");
    assert.match(JSON.stringify(recovered), /hello from fixture/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true });
  }
});

test("malformed ChatGPT SSE chunk fails the loop without starting or completing a tool checkpoint", async () => {
  const temp = mkdtempSync(join(tmpdir(), "di-chatgpt-sse-malformed-"));
  const home = join(temp, "home");
  const workspace = join(temp, "workspace");
  mkdirSync(workspace, { recursive: true });
  const requests: Array<{ url: string; authorization: string; body: unknown }> = [];
  const authState = { calls: 0 };
  let requestCount = 0;
  const server = createServer(async (req, res) => {
    await readRequest(req);
    requestCount++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"unfinished-1","namespace":"di","name":"read_file","arguments":""}}\n\n');
    res.end('data: {"type":"response.function_call_arguments.delta","delta":}\n\n');
  });
  let host: Awaited<ReturnType<typeof createCliHost>> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const runtime = chatGptRuntime(`http://127.0.0.1:${address.port}`, authState, requests);
    host = await createCliHost(makeArgs({ model: "chatgpt/gpt-6.1-sol" }), workspace, new StringTextWriter(), true, {
      diHome: DiHome.fromDirectory(home),
      modelFactory: () => runtime.createModel("chatgpt/gpt-6.1-sol"),
      modelService: new LocalCatalog("chatgpt", "gpt-6.1-sol"),
      tools: createFileTools(workspace),
      skills: [],
    });
    const logFilePath = host.sessionStore?.logFilePath;
    assert.ok(logFilePath, "host must persist a session log");
    let streamFailure: unknown;
    try {
      await host.runner.runTurn("Read missing.txt.");
    } catch (error) {
      streamFailure = error;
    }
    await host.dispose?.();
    const text = readFileSync(logFilePath, "utf8");
    assert.ok(streamFailure instanceof Error, "invalid JSON SSE data must fail the model turn");
    assert.equal(requestCount, 1);
    assert.equal(authState.calls, 1);
    assert.equal(text.includes("checkpoint_tool_started"), false, text);
    assert.equal(text.includes("checkpoint_tool_completed"), false, text);
    assert.equal(text.includes("checkpoint_turn_completed"), false, text);
  } finally {
    if (host !== undefined) await host.dispose?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true });
  }
});

test("truncated local SSE stream never executes or checkpoints a tool completion", async () => {
  const temp = mkdtempSync(join(tmpdir(), "di-sse-truncated-"));
  const home = join(temp, "home");
  const workspace = join(temp, "workspace");
  mkdirSync(workspace, { recursive: true });
  let requestCount = 0;
  const server = createServer(async (req, res) => {
    await readRequest(req);
    requestCount++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"unfinished-1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"missing.txt\\"}"}}]},"finish_reason":null}]}\n\n');
  });
  let host: Awaited<ReturnType<typeof createCliHost>> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    host = await createCliHost(makeArgs({ model: "deepseek-flash" }), workspace, new StringTextWriter(), true, {
      diHome: DiHome.fromDirectory(home),
      modelFactory: () => new DeepSeekAdapter({ model: "deepseek-flash", apiKey: "synthetic-test-key", baseUrl: `http://127.0.0.1:${address.port}` }),
      modelService: new LocalCatalog(),
      tools: createFileTools(workspace),
      skills: [],
    });
    const logFilePath = host.sessionStore?.logFilePath;
    assert.ok(logFilePath, "host must persist a session log");
    let streamFailure: unknown;
    try {
      await host.runner.runTurn("Read missing.txt.");
    } catch (error) {
      streamFailure = error;
    }
    await host.dispose?.();
    const text = readFileSync(logFilePath, "utf8");
    assert.ok(streamFailure instanceof Error, "truncated SSE must fail the model turn");
    assert.equal(requestCount, 1);
    assert.equal(text.includes("checkpoint_tool_started"), false, text);
    assert.equal(text.includes("checkpoint_tool_completed"), false, text);
  } finally {
    if (host !== undefined) await host.dispose?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true });
  }
});
