import test from "node:test";
import assert from "node:assert/strict";

import type { ModelRequest, ToolSpec } from "@di/ai";
import { DeepSeekError, serializeRequest, toWireRequest } from "@di/ai";

/**
 *
 * §DeepSeek 协议边界 items 2-3): internal AgentMessage/ToolSpec history → DeepSeek
 * wire DTO with byte-stable JSON (null vs omission, reasoning entries, tool-call
 * history), thinking/reasoning-effort mapping, tools/tool_choice, and validation
 * (unsupported effort / tool name length / max_tokens limit).
 */

function userHi(): ModelRequest {
  return { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
}

test("toWireRequest maps a minimal system+user request with byte-stable JSON", () => {
  const request: ModelRequest = {
    messages: [
      { role: "system", text: "You are a helpful assistant." },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ],
  };
  const wire = toWireRequest(request, "deepseek-flash");

  assert.deepEqual(wire.messages, [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "hi" },
  ]);
  assert.equal(wire.model, "deepseek-flash");
  assert.equal(wire.stream, true);
  assert.deepEqual(wire.streamOptions, { includeUsage: true });
  assert.equal(wire.thinking, undefined);
  assert.equal(wire.maxTokens, undefined);
  assert.equal(wire.tools, undefined);
  assert.equal(wire.toolChoice, undefined);

  assert.equal(
    serializeRequest(wire),
    `{"messages":[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"hi"}],"model":"deepseek-flash","stream":true,"stream_options":{"include_usage":true}}`,
  );
});

test("toWireRequest echoes reasoning and tool-call history losslessly (null vs omission)", () => {
  const request: ModelRequest = {
    messages: [
      { role: "user", content: [{ type: "text", text: "What's the weather?" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "I need to call the weather tool" },
          { type: "tool-call", id: "call_1", name: "get_weather", arguments: '{"city":"Beijing"}' },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: "Sunny 25C", isError: false },
      { role: "assistant", content: [{ type: "text", text: "The weather in Beijing is sunny." }] },
    ],
  };
  const wire = toWireRequest(request, "deepseek-flash");

  assert.deepEqual(wire.messages, [
    { role: "user", content: "What's the weather?" },
    {
      role: "assistant",
      reasoningContent: "I need to call the weather tool",
      toolCalls: [
        { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Beijing"}' } },
      ],
    },
    { role: "tool", content: "Sunny 25C", toolCallId: "call_1" },
    { role: "assistant", content: "The weather in Beijing is sunny." },
  ]);

  // Reasoning and tool_calls are present; no null/empty defaults are fabricated,
  // and the second assistant message carries neither key.
  assert.equal(
    serializeRequest(wire),
    `{"messages":[{"role":"user","content":"What's the weather?"},{"role":"assistant","reasoning_content":"I need to call the weather tool","tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Beijing\\"}"}}]},{"role":"tool","content":"Sunny 25C","tool_call_id":"call_1"},{"role":"assistant","content":"The weather in Beijing is sunny."}],"model":"deepseek-flash","stream":true,"stream_options":{"include_usage":true}}`,
  );
});

test("toWireRequest emits tools and tool_choice=auto only when tools are present", () => {
  const tool: ToolSpec = {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  };
  const wire = toWireRequest(userHi(), "deepseek-flash");
  const withTools = toWireRequest({ ...userHi(), tools: [tool] }, "deepseek-flash");

  assert.equal(wire.tools, undefined);
  assert.equal(wire.toolChoice, undefined);

  assert.deepEqual(withTools.tools, [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the weather for a city",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    },
  ]);
  assert.equal(withTools.toolChoice, "auto");

  assert.equal(
    serializeRequest(withTools),
    `{"messages":[{"role":"user","content":"hi"}],"model":"deepseek-flash","stream":true,"stream_options":{"include_usage":true},"tools":[{"type":"function","function":{"name":"get_weather","description":"Get the weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}],"tool_choice":"auto"}`,
  );
});

test("emits strict:true and max_tokens only when set", () => {
  const withStrict = toWireRequest(
    { ...userHi(), tools: [{ name: "t", description: "d", parameters: {}, strict: true }], maxTokens: 2048 },
    "deepseek-flash",
  );
  const json = serializeRequest(withStrict);
  assert.ok(json.includes('"strict":true'), "strict:true must be serialized");
  assert.ok(json.includes('"max_tokens":2048'), "max_tokens must be serialized");

  const plain = toWireRequest(
    { ...userHi(), tools: [{ name: "t", description: "d", parameters: {} }] },
    "deepseek-flash",
  );
  assert.ok(!serializeRequest(plain).includes("strict"), "strict=false must be omitted");
});

test("maps reasoning effort onto the thinking block (default/off/none/low/high/max)", () => {
  const make = (reasoningEffort?: string): ModelRequest => ({
    ...userHi(),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  });

  assert.equal(toWireRequest(make(), "deepseek-flash").thinking, undefined);
  assert.equal(toWireRequest(make("default"), "deepseek-flash").thinking, undefined);
  assert.deepEqual(toWireRequest(make("off"), "deepseek-flash").thinking, { type: "disabled" });
  assert.deepEqual(toWireRequest(make("none"), "deepseek-flash").thinking, { type: "disabled" });
  assert.deepEqual(toWireRequest(make("low"), "deepseek-flash").thinking, { type: "enabled", reasoningEffort: "low" });
  assert.deepEqual(toWireRequest(make("high"), "deepseek-flash").thinking, { type: "enabled", reasoningEffort: "high" });
  assert.deepEqual(toWireRequest(make("max"), "deepseek-flash").thinking, { type: "enabled", reasoningEffort: "max" });

  assert.equal(
    serializeRequest(toWireRequest(make("low"), "deepseek-flash")),
    `{"messages":[{"role":"user","content":"hi"}],"model":"deepseek-flash","thinking":{"type":"enabled","reasoning_effort":"low"},"stream":true,"stream_options":{"include_usage":true}}`,
  );
  assert.equal(
    serializeRequest(toWireRequest(make("off"), "deepseek-flash")),
    `{"messages":[{"role":"user","content":"hi"}],"model":"deepseek-flash","thinking":{"type":"disabled"},"stream":true,"stream_options":{"include_usage":true}}`,
  );

  assert.throws(
    () => toWireRequest(make("medium"), "deepseek-flash"),
    (err) =>
      err instanceof DeepSeekError &&
      err.code === "UNSUPPORTED_OPTION" &&
      err.failure.message.includes("medium"),
  );
});

test("maps mixed user content to a parts array and pure text to a string", () => {
  const request: ModelRequest = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          { type: "image", attachmentId: "att-123", detail: "high" },
        ],
      },
    ],
  };
  const wire = toWireRequest(request, "deepseek-flash");

  assert.deepEqual(wire.messages[0]?.content, [
    { type: "text", text: "Look at this" },
    { type: "image_url", imageUrl: { url: "att-123", detail: "high" } },
  ]);
  assert.equal(
    serializeRequest(wire),
    `{"messages":[{"role":"user","content":[{"type":"text","text":"Look at this"},{"type":"image_url","image_url":{"url":"att-123","detail":"high"}}]}],"model":"deepseek-flash","stream":true,"stream_options":{"include_usage":true}}`,
  );
});

test("rejects an unsupported user content block type with UNSUPPORTED_OPTION", () => {
  const request: ModelRequest = {
    messages: [{ role: "user", content: [{ type: "file", attachmentId: "f1", filename: "x.txt" }] }],
  };
  assert.throws(
    () => toWireRequest(request, "deepseek-flash"),
    (err) => err instanceof DeepSeekError && err.code === "UNSUPPORTED_OPTION",
  );
});

test("rejects a tool name longer than 128 characters", () => {
  const request: ModelRequest = {
    ...userHi(),
    tools: [{ name: "x".repeat(129), description: "d", parameters: {} }],
  };
  assert.throws(
    () => toWireRequest(request, "deepseek-flash"),
    (err) => err instanceof DeepSeekError && err.code === "INVALID_REQUEST",
  );
});

test("rejects max_tokens above the DeepSeek limit", () => {
  const request: ModelRequest = { ...userHi(), maxTokens: 400_000 };
  assert.throws(
    () => toWireRequest(request, "deepseek-flash"),
    (err) => err instanceof DeepSeekError && err.code === "INVALID_REQUEST",
  );
});
