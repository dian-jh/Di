import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createEditFileTool } from "@di/coding-agent";

/**
 *
 * exist and occur exactly once (no fuzzy replacement), overlapping occurrences count
 * as ambiguous, CRLF/LF style is preserved on write-back, UTF-8 BOM is kept, and a
 * failed edit never leaves the file partially corrupted.
 */

const base = mkdtempSync(join(tmpdir(), "di-edit-"));
test.after(() => rmSync(base, { recursive: true, force: true }));

function write(name: string, content: string): string {
  const path = join(base, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function writeBytes(name: string, bytes: readonly number[]): void {
  writeFileSync(join(base, name), Buffer.from(bytes));
}

async function run(path: string, oldString: string, newString: string) {
  return createEditFileTool(base).execute(JSON.stringify({ path, old_string: oldString, new_string: newString }));
}

test("unique match replaces it", async () => {
  write("a.txt", "hello world");
  const obs = await run("a.txt", "world", "there");
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "a.txt"), "utf8"), "hello there");
});

test("multiple occurrences return an ambiguity error without changing the file", async () => {
  write("a.txt", "x y x y");
  const obs = await run("a.txt", "y", "z");
  assert.ok(obs.isError);
  assert.match(obs.text, /多次/);
  assert.equal(readFileSync(join(base, "a.txt"), "utf8"), "x y x y");
});

test("not found returns an error without changing the file", async () => {
  write("a.txt", "hello");
  const obs = await run("a.txt", "missing", "x");
  assert.ok(obs.isError);
  assert.match(obs.text, /未找到/);
  assert.equal(readFileSync(join(base, "a.txt"), "utf8"), "hello");
});

test("non-existent file returns an error", async () => {
  const obs = await run("missing.txt", "a", "b");
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("empty old_string returns an error naming old_string", async () => {
  write("a.txt", "hello");
  const obs = await run("a.txt", "", "x");
  assert.ok(obs.isError);
  assert.match(obs.text, /old_string/);
});

test("old_string equal to new_string is a no-op", async () => {
  write("a.txt", "hello world");
  const obs = await run("a.txt", "world", "world");
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "a.txt"), "utf8"), "hello world");
});

test("multiline old_string replaces across lines", async () => {
  write("a.txt", "one\ntwo\nthree");
  const obs = await run("a.txt", "one\ntwo", "1\n2");
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "a.txt"), "utf8"), "1\n2\nthree");
});

test("surrounding content is preserved", async () => {
  write("a.txt", "start [to-replace] end");
  await run("a.txt", "[to-replace]", "[new]");
  assert.equal(readFileSync(join(base, "a.txt"), "utf8"), "start [new] end");
});

test("new_string longer than old_string expands the file", async () => {
  write("a.txt", "ab");
  const obs = await run("a.txt", "b", "bbbbbb");
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "a.txt"), "utf8"), "abbbbbb");
});

test("unique match after a line-numbered read works (common agent flow)", async () => {
  write("a.txt", "def foo():\n    pass\n");
  const obs = await run("a.txt", "def foo():", "def foo():\n    # added");
  assert.ok(obs.text.startsWith("OK"));
  assert.ok(readFileSync(join(base, "a.txt"), "utf8").includes("# added"));
});

test("confirmation mentions the line counts", async () => {
  write("a.txt", "a\nb\nc");
  const obs = await run("a.txt", "b", "x\ny\nz");
  assert.ok(obs.text.startsWith("OK"));
  assert.match(obs.text, /1 行 → 3 行/);
});

test("missing path argument returns an error", async () => {
  const obs = await createEditFileTool(base).execute(
    JSON.stringify({ old_string: "a", new_string: "b" }),
  );
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("missing new_string argument returns an error naming new_string", async () => {
  write("a.txt", "a");
  const obs = await createEditFileTool(base).execute(JSON.stringify({ path: "a.txt", old_string: "a" }));
  assert.ok(obs.isError);
  assert.match(obs.text, /new_string/);
});

test("invalid JSON arguments return an error", async () => {
  const obs = await createEditFileTool(base).execute("{bad");
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("definition is an edit_file ToolSpec with old_string/new_string schema", () => {
  const spec = createEditFileTool(base).spec;
  assert.equal(spec.name, "edit_file");
  assert.equal(typeof spec.description, "string");
  assert.ok(spec.description.length > 0);
  const properties = spec.parameters.properties as Record<string, { type: string }>;
  assert.ok(properties.old_string);
  assert.ok(properties.new_string);
  assert.deepEqual(spec.parameters.required, ["path", "old_string", "new_string"]);
});

test("overlapping occurrences are reported as ambiguous", async () => {
  write("a.txt", "aaa");
  const obs = await run("a.txt", "aa", "b");
  assert.ok(obs.isError);
  assert.match(obs.text, /多次/);
  assert.equal(readFileSync(join(base, "a.txt"), "utf8"), "aaa");
});

test("old_string at file start is replaced", async () => {
  write("a.txt", "abcdef");
  const obs = await run("a.txt", "ab", "X");
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "a.txt"), "utf8"), "Xcdef");
});

test("old_string at file end is replaced", async () => {
  write("a.txt", "abcdef");
  const obs = await run("a.txt", "ef", "X");
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "a.txt"), "utf8"), "abcdX");
});

test("empty new_string deletes the text", async () => {
  write("a.txt", "remove this part");
  const obs = await run("a.txt", "this ", "");
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "a.txt"), "utf8"), "remove part");
});

test("path with NUL character returns an error instead of throwing", async () => {
  const obs = await run("bad\u0000dir.txt", "a", "b");
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("unicode content is edited correctly", async () => {
  write("u.txt", "你好世界");
  const obs = await run("u.txt", "世界", "地球");
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "u.txt"), "utf8"), "你好地球");
});

test("CRLF file edited with a CRLF old_string works", async () => {
  write("crlf.txt", "a\r\nb\r\nc");
  const obs = await run("crlf.txt", "b\r\nc", "X");
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "crlf.txt"), "utf8"), "a\r\nX");
});

test("CRLF file edited with an LF old_string works and preserves CRLF", async () => {
  write("crlf.txt", "a\r\nb");
  const obs = await run("crlf.txt", "a\nb", "x\ny");
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "crlf.txt"), "utf8"), "x\r\ny");
});

test("CRLF multiline edit preserves CRLF everywhere", async () => {
  write("crlf.txt", "one\r\ntwo\r\nthree");
  const obs = await run("crlf.txt", "one\ntwo", "1\n2");
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "crlf.txt"), "utf8"), "1\r\n2\r\nthree");
});

test("UTF-8 BOM is preserved after an edit", async () => {
  writeBytes("bom.txt", [0xef, 0xbb, 0xbf, ...Buffer.from("hello world", "utf8")]);
  const obs = await run("bom.txt", "world", "there");
  assert.ok(obs.text.startsWith("OK"));
  const bytes = readFileSync(join(base, "bom.txt"));
  assert.ok(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, "UTF-8 BOM preserved");
  assert.equal(bytes.subarray(3).toString("utf8"), "hello there");
});

test("whole file as old_string replaces everything", async () => {
  write("a.txt", "entire\ncontent");
  const obs = await run("a.txt", "entire\ncontent", "new");
  assert.ok(obs.text.startsWith("OK"));
  assert.equal(readFileSync(join(base, "a.txt"), "utf8"), "new");
});

test("already-aborted signal rejects with AbortError and leaves the file unchanged", async () => {
  write("a.txt", "hello");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => createEditFileTool(base).execute(JSON.stringify({ path: "a.txt", old_string: "hello", new_string: "bye" }), controller.signal),
    { name: "AbortError" },
  );
  assert.equal(readFileSync(join(base, "a.txt"), "utf8"), "hello");
});
