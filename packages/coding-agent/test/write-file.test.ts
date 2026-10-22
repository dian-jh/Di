import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createWriteFileTool } from "@di/coding-agent";

/**
 * P4.1 card 1: write_file tool.
 *
 * Mirrors Di.Tests/Tools/WriteFileToolTests.cs at baseline 09f4e08: full-file
 * overwrite (never append), auto-created parent directories, error paths with no
 * silent data loss. UTF-8 without BOM (matches the .NET default serializer).
 */

const base = mkdtempSync(join(tmpdir(), "di-write-"));
test.after(() => rmSync(base, { recursive: true, force: true }));

async function run(args: unknown) {
  return createWriteFileTool(base).execute(JSON.stringify(args));
}

test("creates a new file and content round-trips", async () => {
  const obs = await run({ path: "hello.txt", content: "hello world" });
  assert.equal(obs.isError, false);
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "hello.txt"), "utf8"), "hello world");
});

test("overwrites an existing file completely", async () => {
  writeFileSync(join(base, "a.txt"), "old");
  const obs = await run({ path: "a.txt", content: "new content" });
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "a.txt"), "utf8"), "new content");
});

test("deep nested path creates parent directories", async () => {
  const obs = await run({ path: "a/b/c/d.txt", content: "x" });
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "a", "b", "c", "d.txt"), "utf8"), "x");
});

test("empty content creates an empty file", async () => {
  const obs = await run({ path: "empty.txt", content: "" });
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "empty.txt"), "utf8"), "");
});

test("multiline content is preserved exactly", async () => {
  const content = "line1\nline2\nline3";
  await run({ path: "m.txt", content });
  assert.equal(readFileSync(join(base, "m.txt"), "utf8"), content);
});

test("path that is an existing directory returns an error and leaves it intact", async () => {
  mkdirSync(join(base, "adir"));
  const obs = await run({ path: "adir", content: "x" });
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
  assert.ok(join(base, "adir"), "directory not destroyed");
});

test("missing path argument returns an error naming path", async () => {
  const obs = await run({ content: "x" });
  assert.ok(obs.isError);
  assert.match(obs.text, /path/);
});

test("missing content argument returns an error naming content", async () => {
  const obs = await run({ path: "a.txt" });
  assert.ok(obs.isError);
  assert.match(obs.text, /content/);
});

test("content that is not a string returns an error", async () => {
  const obs = await run({ path: "a.txt", content: 42 });
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("invalid JSON arguments return an error", async () => {
  const obs = await createWriteFileTool(base).execute("not json");
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("backslashes follow native path semantics", async () => {
  const obs = await run({ path: "sub\\file.txt", content: "x" });
  assert.ok(obs.text.startsWith("OK"));
  const expected = process.platform === "win32"
    ? join(base, "sub", "file.txt")
    : join(base, "sub\\file.txt");
  assert.equal(readFileSync(expected, "utf8"), "x");
});

test("confirmation mentions the path and the content length", async () => {
  const obs = await run({ path: "out.txt", content: "data" });
  assert.ok(obs.text.includes("out.txt"));
  assert.ok(obs.text.includes("4"));
});

test("definition is a write_file ToolSpec with path and content schema", () => {
  const spec = createWriteFileTool(base).spec;
  assert.equal(spec.name, "write_file");
  assert.equal(typeof spec.description, "string");
  assert.ok(spec.description.length > 0);
  const properties = spec.parameters.properties as Record<string, { type: string }>;
  assert.ok(properties.path);
  assert.ok(properties.content);
  assert.deepEqual(spec.parameters.required, ["path", "content"]);
});

test("parent path that is a file returns an error", async () => {
  writeFileSync(join(base, "blocker"), "I am a file");
  const obs = await run({ path: "blocker/child.txt", content: "x" });
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("path with NUL character returns an error instead of throwing", async () => {
  const obs = await run({ path: "bad\u0000dir.txt", content: "x" });
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("read-only file returns an error on Windows", async (t) => {
  if (process.platform !== "win32") {
    t.skip("read-only attribute semantics are Windows-specific");
    return;
  }
  const path = join(base, "ro.txt");
  writeFileSync(path, "old");
  chmodSync(path, 0o444);
  try {
    const obs = await run({ path: "ro.txt", content: "new" });
    assert.ok(obs.isError);
    assert.ok(obs.text.startsWith("error:"));
  } finally {
    chmodSync(path, 0o666);
  }
});

test("unicode content round-trips exactly", async () => {
  const content = "你好世界\nline 2 with 😀 emoji";
  await run({ path: "u.txt", content });
  assert.equal(readFileSync(join(base, "u.txt"), "utf8"), content);
});

test("overwrite with shorter content shrinks the file", async () => {
  writeFileSync(join(base, "a.txt"), "x".repeat(1000));
  await run({ path: "a.txt", content: "tiny" });
  assert.equal(readFileSync(join(base, "a.txt"), "utf8"), "tiny");
});

test("written bytes are UTF-8 without BOM", async () => {
  await run({ path: "nobom.txt", content: "你好" });
  const bytes = readFileSync(join(base, "nobom.txt"));
  assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), "no UTF-8 BOM");
  assert.equal(bytes.toString("utf8"), "你好");
});

test("already-aborted signal rejects with AbortError and writes nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => createWriteFileTool(base).execute(JSON.stringify({ path: "aborted.txt", content: "x" }), controller.signal),
    { name: "AbortError" },
  );
  assert.ok(!exists(join(base, "aborted.txt")), "file must not be created after abort");
});

function exists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
