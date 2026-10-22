import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createReadFileTool } from "@di/coding-agent";
import { createLegacyDecoder, discoverOemCodePage } from "../src/core/tools/encoding.ts";

/**
 * P4.1 card 1: read_file tool.
 *
 * Mirrors Di.Tests/Tools/ReadFileToolTests.cs at baseline 09f4e08: line numbers,
 * range reads, continuation notices, budget truncation and failure paths. Decoding
 * follows the P4-win-encoding-probe findings: UTF-8 first (BOM stripped), OEM
 * code page fallback for non-UTF-8 files, explicit error when no decoder exists.
 *
 * All file IO happens in an isolated temp dir; never touches user files.
 */

const base = mkdtempSync(join(tmpdir(), "di-read-"));
test.after(() => rmSync(base, { recursive: true, force: true }));

function write(name: string, content: string): string {
  const path = join(base, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function writeBytes(name: string, bytes: readonly number[]): string {
  const path = join(base, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(bytes));
  return path;
}

async function run(name: string, args: unknown) {
  return createReadFileTool(base).execute(JSON.stringify(args));
}

test("existing file returns content with line numbers", async () => {
  write("a.txt", "first\nsecond\nthird");
  const obs = await run("a.txt", { path: "a.txt" });
  assert.equal(obs.isError, false);
  assert.equal(obs.text, "1: first\n2: second\n3: third");
});

test("file without trailing newline includes the last line", async () => {
  write("a.txt", "one\ntwo");
  const obs = await run("a.txt", { path: "a.txt" });
  assert.equal(obs.text, "1: one\n2: two");
});

test("empty file returns an empty observation", async () => {
  write("a.txt", "");
  const obs = await run("a.txt", { path: "a.txt" });
  assert.equal(obs.isError, false);
  assert.equal(obs.text, "");
});

test("CRLF file lines are split correctly and rendered as LF", async () => {
  write("a.txt", "line1\r\nline2\r\n");
  const obs = await run("a.txt", { path: "a.txt" });
  assert.equal(obs.text, "1: line1\n2: line2");
});

test("subdirectory path resolves relative to the base directory", async () => {
  write(join("src", "a.cs"), "code");
  const obs = await run("a.cs", { path: "src/a.cs" });
  assert.equal(obs.text, "1: code");
});

test("backslashes follow native path semantics", async () => {
  if (process.platform === "win32") {
    write(join("src", "b.cs"), "x");
    const obs = await run("b.cs", { path: "src\\b.cs" });
    assert.equal(obs.text, "1: x");
  } else {
    write("src\\b.cs", "x");
    const obs = await run("b.cs", { path: "src\\b.cs" });
    assert.equal(obs.text, "1: x");
  }
});

test("start_line and end_line return that slice and hint at remaining lines", async () => {
  write("a.txt", "1\n2\n3\n4\n5");
  const obs = await run("a.txt", { path: "a.txt", start_line: 2, end_line: 4 });
  assert.ok(obs.text.startsWith("2: 2\n3: 3\n4: 4"), obs.text);
  assert.match(obs.text, /还有 1 行/);
  assert.match(obs.text, /用 start_line=5 继续读取/);
});

test("start_line only reads to the end", async () => {
  write("a.txt", "1\n2\n3");
  const obs = await run("a.txt", { path: "a.txt", start_line: 2 });
  assert.equal(obs.text, "2: 2\n3: 3");
});

test("end_line beyond file length clamps to EOF", async () => {
  write("a.txt", "1\n2");
  const obs = await run("a.txt", { path: "a.txt", start_line: 1, end_line: 999 });
  assert.equal(obs.text, "1: 1\n2: 2");
});

test("start_line above line count returns an error", async () => {
  write("a.txt", "1\n2");
  const obs = await run("a.txt", { path: "a.txt", start_line: 5 });
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("end_line below start_line returns an error", async () => {
  write("a.txt", "1\n2\n3");
  const obs = await run("a.txt", { path: "a.txt", start_line: 3, end_line: 1 });
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("start_line below one returns an error", async () => {
  write("a.txt", "1\n2");
  const obs = await run("a.txt", { path: "a.txt", start_line: 0 });
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("over max output lines adds a continuation notice", async () => {
  const lines = Array.from({ length: 2000 + 500 }, (_, i) => `line ${i + 1}`).join("\n");
  write("big.txt", lines);
  const obs = await run("big.txt", { path: "big.txt" });
  assert.ok(obs.text.includes("1: line 1"), obs.text);
  assert.ok(obs.text.includes("2000: line 2000"), obs.text);
  assert.ok(!obs.text.includes("line 2001"), obs.text);
  assert.match(obs.text, /用 start_line=2001 继续读取/);
  assert.match(obs.text, /共 2500 行/);
});

test("user end_line stopping early reports remaining lines", async () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  write("a.txt", lines);
  const obs = await run("a.txt", { path: "a.txt", start_line: 1, end_line: 10 });
  assert.ok(obs.text.includes("1: line 1"), obs.text);
  assert.ok(obs.text.includes("10: line 10"), obs.text);
  assert.match(obs.text, /还有 90 行/);
  assert.match(obs.text, /用 start_line=11 继续读取/);
});

test("output over the byte budget truncates at a line boundary with a notice", async () => {
  const content = Array.from({ length: 20 }, () => "x".repeat(64 * 1024 / 8)).join("\n");
  write("wide.txt", content);
  const obs = await run("wide.txt", { path: "wide.txt" });
  assert.match(obs.text, /继续读取/);
  const renderedLines = obs.text.split("\n").length;
  assert.ok(renderedLines < 20, `should truncate to a subset of lines, got ${renderedLines}`);
});

test("non-existent file returns an error naming 不存在", async () => {
  const obs = await run("missing.txt", { path: "missing.txt" });
  assert.ok(obs.isError);
  assert.match(obs.text, /不存在/);
});

test("path that is a directory returns an error", async () => {
  mkdirSync(join(base, "adir"));
  const obs = await run("adir", { path: "adir" });
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("missing path argument returns an error naming path", async () => {
  const obs = await run("x", {});
  assert.ok(obs.isError);
  assert.match(obs.text, /path/);
});

test("path that is not a string returns an error", async () => {
  const obs = await run("x", { path: 123 });
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("start_line that is not an integer returns an error naming start_line", async () => {
  write("a.txt", "x");
  const obs = await run("a.txt", { path: "a.txt", start_line: "2" });
  assert.ok(obs.isError);
  assert.match(obs.text, /start_line/);
});

test("invalid JSON arguments return an error", async () => {
  const obs = await createReadFileTool(base).execute("{not json");
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("oversized file returns an error mentioning 过大", async () => {
  write("big.bin", "x".repeat((1 << 20) + 1));
  const obs = await run("big.bin", { path: "big.bin" });
  assert.ok(obs.isError);
  assert.match(obs.text, /过大/);
});

test("definition is a read_file ToolSpec with path schema", () => {
  const spec = createReadFileTool(base).spec;
  assert.equal(spec.name, "read_file");
  assert.equal(typeof spec.description, "string");
  assert.ok(spec.description.length > 0);
  assert.equal(spec.parameters.type, "object");
  const properties = spec.parameters.properties as Record<string, { type: string }>;
  assert.ok(properties.path, "path property present");
  assert.equal(properties.path.type, "string");
  assert.deepEqual(spec.parameters.required, ["path"]);
  assert.ok(properties.start_line, "start_line optional property present");
  assert.ok(!(spec.parameters.required as string[]).includes("start_line"));
  assert.ok(!(spec.parameters.required as string[]).includes("end_line"));
});

test("file exactly at max bytes is readable with a continuation hint", async () => {
  // ~104857 short lines (~734 KB) — under 1 MiB, over the 2000-line render budget.
  const lines = Array.from({ length: Math.floor((1 << 20) / 10) }, (_, i) => `line${i}`).join("\n");
  write("at.txt", lines);
  const obs = await run("at.txt", { path: "at.txt" });
  assert.ok(obs.text.startsWith("1: "), obs.text.slice(0, 40));
  assert.match(obs.text, /继续读取/);
});

test("path with NUL character returns an error instead of throwing", async () => {
  const obs = await run("nul", { path: "bad\u0000dir.txt" });
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("unicode content keeps line numbers correct", async () => {
  write("c.txt", "第一行\n第二行\nthird");
  const obs = await run("c.txt", { path: "c.txt" });
  assert.equal(obs.text, "1: 第一行\n2: 第二行\n3: third");
});

test("blank lines are preserved with numbers", async () => {
  write("b.txt", "a\n\nb");
  const obs = await run("b.txt", { path: "b.txt" });
  assert.equal(obs.text, "1: a\n2: \n3: b");
});

test("long single line within the output budget is returned in full", async () => {
  write("long.txt", "x" + "y".repeat(5000));
  const obs = await run("long.txt", { path: "long.txt" });
  assert.ok(obs.text.startsWith("1: x"));
  assert.ok(obs.text.includes("y".repeat(5000)));
});

test("file containing only a newline reports one blank line", async () => {
  write("nl.txt", "\n");
  const obs = await run("nl.txt", { path: "nl.txt" });
  assert.equal(obs.text, "1: ");
});

test("UTF-8 BOM is stripped from the first line", async () => {
  writeBytes("bom.txt", [0xef, 0xbb, 0xbf, 0x68, 0x69]); // BOM + "hi"
  const obs = await run("bom.txt", { path: "bom.txt" });
  assert.equal(obs.text, "1: hi");
});

test("GBK-encoded file falls back to the OEM code page (explicit 936)", async () => {
  // "你好" as GBK bytes (C4E3 BAC3). Strict UTF-8 fails -> OEM (gbk) decode.
  writeBytes("gbk.txt", [0xc4, 0xe3, 0xba, 0xc3]);
  const obs = await createReadFileTool(base, { oemCodePage: 936 }).execute(
    JSON.stringify({ path: "gbk.txt" }),
  );
  assert.equal(obs.isError, false);
  assert.equal(obs.text, "1: 你好");
});

test("GBK bytes use the discovered OEM decoder or return an explicit decode error", async () => {
  const bytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // 你好 in GBK; invalid UTF-8.
  writeBytes("gbk-auto.txt", [...bytes]);

  const codePage = await discoverOemCodePage();
  const decoder = codePage === undefined ? undefined : createLegacyDecoder(codePage);
  const obs = await run("gbk-auto.txt", { path: "gbk-auto.txt" });

  if (codePage === 936 && decoder !== undefined) {
    assert.equal(obs.isError, false);
    assert.equal(obs.text, "1: 你好");
  } else if (decoder === undefined || codePage === 65001) {
    assert.equal(obs.isError, true);
    assert.match(obs.text, /无法解码/);
  } else {
    assert.equal(obs.isError, false);
    assert.equal(obs.text, `1: ${decoder(bytes)}`);
  }
});

test("non-UTF-8 file with an unavailable OEM decoder returns an explicit decode error", async () => {
  // OEM 437 has no ICU TextDecoder label; per probe the failure path must be explicit.
  writeBytes("gbk-nod.txt", [0xc4, 0xe3, 0xba, 0xc3]);
  const obs = await createReadFileTool(base, { oemCodePage: 437 }).execute(
    JSON.stringify({ path: "gbk-nod.txt" }),
  );
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
  assert.match(obs.text, /无法解码|解码/);
});

test("already-aborted signal rejects with AbortError before any IO", async () => {
  write("a.txt", "hello");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => createReadFileTool(base).execute(JSON.stringify({ path: "a.txt" }), controller.signal),
    { name: "AbortError" },
  );
});

test("maxBytes option raises the oversize rejection threshold", async () => {
  // Default threshold is 1 MiB; override to a small value so a tiny file is rejected.
  write("small.txt", "abc");
  const obs = await createReadFileTool(base, { maxBytes: 2 }).execute(
    JSON.stringify({ path: "small.txt" }),
  );
  assert.ok(obs.isError);
  assert.match(obs.text, /过大/);
});
