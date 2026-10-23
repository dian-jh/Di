import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileTools, createToolExecutor } from "@di/coding-agent";

/**
 *
 * tools-and-platform.md §"工具契约": each tool is a ToolSpec (name/description/
 * JSON-Schema parameters) co-located with its execution function, and the schema
 * set stays consistent with the executor set. This card owns the three file tools;
 *
 */

const base = mkdtempSync(join(tmpdir(), "di-tools-"));
test.after(() => rmSync(base, { recursive: true, force: true }));

test("fileTools expose read/write/edit in canonical order", () => {
  assert.deepEqual(
    createFileTools(base).map((tool) => tool.spec.name),
    ["read_file", "write_file", "edit_file"],
  );
});

test("each file tool carries promptSnippet and promptGuidelines", () => {
  for (const tool of createFileTools(base)) {
    assert.equal(typeof tool.promptSnippet, "string");
    assert.ok(tool.promptSnippet.length > 0, `${tool.spec.name} promptSnippet`);
    assert.ok(Array.isArray(tool.promptGuidelines));
    assert.ok(tool.promptGuidelines.length > 0, `${tool.spec.name} promptGuidelines`);
  }
});

test("schema set and executor set are consistent", async () => {
  const tools = createFileTools(base);
  const executor = createToolExecutor(tools);
  for (const tool of tools) {
    // A call routed by name reaches the tool with that spec name.
    const obs = await executor.execute({
      type: "tool-call",
      id: "1",
      name: tool.spec.name,
      arguments: JSON.stringify({ path: "does-not-exist.txt" }),
    });
    assert.match(obs.text, /error:/, `${tool.spec.name} routed`);
  }
});

test("executor routes a real read call end to end", async () => {
  writeFileSync(join(base, "hello.txt"), "hi");
  const executor = createToolExecutor(createFileTools(base));
  const obs = await executor.execute({
    type: "tool-call",
    id: "1",
    name: "read_file",
    arguments: JSON.stringify({ path: "hello.txt" }),
  });
  assert.equal(obs.isError, false);
  assert.equal(obs.text, "1: hi");
});

test("unknown tool name returns an error observation, not a throw", async () => {
  const executor = createToolExecutor(createFileTools(base));
  const obs = await executor.execute({ type: "tool-call", id: "1", name: "nope", arguments: "{}" });
  assert.equal(obs.isError, true);
  assert.equal(obs.text, "error: 未知工具 'nope'");
});

test("read/write/edit required vs optional schema fields", () => {
  const [read, write, edit] = createFileTools(base);
  const req = (spec: { parameters: Readonly<Record<string, unknown>> }) =>
    spec.parameters.required as string[];
  assert.deepEqual(req(read!.spec), ["path"]);
  assert.deepEqual(req(write!.spec), ["path", "content"]);
  assert.deepEqual(req(edit!.spec), ["path", "old_string", "new_string"]);
});
