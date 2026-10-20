import test from "node:test";
import assert from "node:assert/strict";

import type { ModelRequest, ToolSpec } from "@di/ai";
import { ChatGptError, toChatGptWireRequest, serializeChatGptRequest } from "@di/ai";

/**
 * P8a card red list — ChatGPT Responses request translation (Di baseline
 * `Core/Providers/ChatGpt/ChatGptTranslator.cs` `Request`; models-and-auth.md
 * §"Responses wire 与 SSE"): stateless request (`store:false`, `stream:true`,
 * full input history, NO `previous_response_id`), system → developer role,
 * tools into the Di namespace, explicitly-unsupported sampling/penalty/max-token
 * /stop options rejected with `UNSUPPORTED_OPTION` before sending, and the raw
 * output replay path (verbatim `response.output` vs the C#-compatible legacy
 * replay of encrypted reasoning + normalized display blocks).
 */

function baseRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    messages: [
      { role: "system", text: "You are Di" },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ],
    ...overrides,
  };
}

test("builds a stateless request with store:false, stream:true and no previous_response_id", () => {
  const wire = toChatGptWireRequest(baseRequest(), "gpt-6.1-sol");
  assert.equal(wire.model, "gpt-6.1-sol");
  assert.equal(wire.store, false);
  assert.equal(wire.stream, true);
  assert.deepEqual(wire.include, ["reasoning.encrypted_content"]);
  assert.equal(wire.promptCacheKey, undefined);
  assert.equal(wire.reasoning, undefined);
  assert.equal(wire.tools, undefined);
  assert.equal(wire.toolChoice, undefined);
  assert.equal(
    serializeChatGptRequest(wire),
    '{"model":"gpt-6.1-sol","input":[{"role":"developer","content":"You are Di"},{"role":"user","content":[{"type":"input_text","text":"Hello"}]}],"store":false,"stream":true,"include":["reasoning.encrypted_content"]}',
  );
  assert.ok(!serializeChatGptRequest(wire).includes("previous_response_id"));
});

test("maps system messages to the developer role and full history onto input items", () => {
  const request: ModelRequest = {
    messages: [
      { role: "system", text: "You are Di" },
      { role: "user", content: [{ type: "text", text: "What is the weather?" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "I will call the weather tool" },
          { type: "text", text: "Let me check." },
          { type: "tool-call", id: "call_1", name: "get_weather", arguments: '{"city":"Beijing"}' },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: "Sunny 25C", isError: false },
      { role: "assistant", content: [{ type: "text", text: "The weather is sunny." }] },
    ],
  };
  const wire = toChatGptWireRequest(request, "gpt-6.1-sol");
  assert.deepEqual(wire.input, [
    { role: "developer", content: "You are Di" },
    { role: "user", content: [{ type: "input_text", text: "What is the weather?" }] },
    { role: "assistant", content: [{ type: "output_text", text: "Let me check." }] },
    { type: "function_call", call_id: "call_1", name: "get_weather", namespace: "di", arguments: '{"city":"Beijing"}' },
    { type: "function_call_output", call_id: "call_1", output: "Sunny 25C" },
    { role: "assistant", content: [{ type: "output_text", text: "The weather is sunny." }] },
  ]);
});

test("rejects explicitly unsupported sampling/penalty/max-token/stop options before sending", () => {
  const cases: Array<Partial<ModelRequest>> = [
    { temperature: 0.5 },
    { topP: 0.9 },
    { frequencyPenalty: 0.1 },
    { presencePenalty: 0.1 },
    { maxTokens: 512 },
    { stop: ["END"] },
  ];
  for (const option of cases) {
    assert.throws(
      () => toChatGptWireRequest(baseRequest(option), "gpt-6.1-sol"),
      (err) => err instanceof ChatGptError && err.code === "UNSUPPORTED_OPTION",
      `option=${JSON.stringify(option)}`,
    );
  }
  // An empty stop list is not an explicit stop option (C# `Stop is { Count: > 0 }`).
  const wire = toChatGptWireRequest(baseRequest({ stop: [] }), "gpt-6.1-sol");
  assert.equal(wire.stream, true);
});

test("wraps tools into the di namespace and requests auto tool choice", () => {
  const tool: ToolSpec = {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } } },
    strict: true,
  };
  const wire = toChatGptWireRequest(baseRequest({ tools: [tool] }), "gpt-6.1-sol");
  assert.deepEqual(wire.tools, [
    {
      type: "namespace",
      name: "di",
      description: "Di harness tools, executed locally.",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get the weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } } },
          strict: true,
        },
      ],
    },
  ]);
  assert.equal(wire.toolChoice, "auto");
  assert.ok(serializeChatGptRequest(wire).includes('"type":"namespace","name":"di"'));
});

test("maps reasoning effort onto the reasoning block and omits it for default", () => {
  assert.deepEqual(toChatGptWireRequest(baseRequest({ reasoningEffort: "high" }), "gpt-6.1-sol").reasoning, {
    effort: "high",
    summary: "auto",
  });
  assert.equal(toChatGptWireRequest(baseRequest(), "gpt-6.1-sol").reasoning, undefined);
  assert.equal(toChatGptWireRequest(baseRequest({ reasoningEffort: "default" }), "gpt-6.1-sol").reasoning, undefined);
});

test("maps user text/image/file blocks onto input parts and rejects unresolved attachments", () => {
  const wire = toChatGptWireRequest(
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this" },
            { type: "image", attachmentId: "data:image/png;base64,AAA", detail: "high" },
            { type: "file", attachmentId: "data:application/pdf;base64,BBB", filename: "doc.pdf" },
          ],
        },
      ],
    },
    "gpt-6.1-sol",
  );
  assert.deepEqual(wire.input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "Look at this" },
        { type: "input_image", image_url: "data:image/png;base64,AAA", detail: "high" },
        { type: "input_file", file_data: "data:application/pdf;base64,BBB", filename: "doc.pdf" },
      ],
    },
  ]);
  // An unresolved attachment (not a data: URL and not an https URL) is rejected.
  assert.throws(
    () =>
      toChatGptWireRequest(
        { messages: [{ role: "user", content: [{ type: "image", attachmentId: "att-123" }] }] },
        "gpt-6.1-sol",
      ),
    (err) => err instanceof ChatGptError && err.code === "UNSUPPORTED_OPTION",
  );
});

test("replays original response.output items verbatim and never re-sends normalized blocks", () => {
  const output = [
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "first", annotations: [] }],
    },
    {
      type: "message",
      id: "msg_2",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "second", annotations: [] }],
    },
  ];
  const wire = toChatGptWireRequest(
    {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "normalized display text that must NOT be re-sent" },
            { type: "chatgpt.output", rawJson: JSON.stringify(output) },
          ],
        },
        { role: "user", content: [{ type: "text", text: "next" }] },
      ],
    },
    "gpt-6.1-sol",
  );
  assert.deepEqual(wire.input[0], output[0]);
  assert.deepEqual(wire.input[1], output[1]);
  assert.equal(wire.input.length, 3);
  const json = serializeChatGptRequest(wire);
  assert.ok(json.includes('"text":"first"'));
  assert.ok(!json.includes("normalized display text"));
});

test("replays old history without raw output via the C#-compatible path", () => {
  const wire = toChatGptWireRequest(
    {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "display summary" },
            {
              type: "chatgpt.reasoning",
              rawJson: JSON.stringify({ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" }),
            },
            { type: "text", text: "Working" },
            { type: "tool-call", id: "call_1", name: "shell", arguments: '{"cmd":"pwd"}' },
          ],
        },
        { role: "tool", toolCallId: "call_1", content: "result", isError: false },
      ],
    },
    "gpt-6.1-sol",
  );
  // Encrypted reasoning precedes calls; the display summary is not replayed.
  assert.deepEqual(wire.input[0], { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" });
  assert.deepEqual(wire.input[1], { role: "assistant", content: [{ type: "output_text", text: "Working" }] });
  assert.deepEqual(wire.input[2], { type: "function_call", call_id: "call_1", name: "shell", namespace: "di", arguments: '{"cmd":"pwd"}' });
  assert.deepEqual(wire.input[3], { type: "function_call_output", call_id: "call_1", output: "result" });
});

test("rejects an unsupported opaque assistant block", () => {
  assert.throws(
    () =>
      toChatGptWireRequest(
        { messages: [{ role: "assistant", content: [{ type: "chatgpt.other", rawJson: "{}" }] }] },
        "gpt-6.1-sol",
      ),
    (err) => err instanceof ChatGptError && err.code === "UNSUPPORTED_OPTION",
  );
});
