import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGrepTool,
  GREP_DEFAULT_LIMIT,
  type GrepToolOptions,
} from "@di/coding-agent";

/** Matches GrepTool.MaxFileBytes (1 MiB): files larger than this are skipped. */
const GREP_MAX_BYTES_FOR_TEST = 1 << 20;

/**
 * P4.3 card 3: grep tool (regex search over enumerated files).
 *
 * Ports Di.Tests/Tools/GrepToolTests.cs at baseline 09f4e08 and adds the red
 * cases from tools-and-platform.md §".NET 与 JavaScript 搜索语义差异" + the
 * P4-regex-probe worker findings: every bounded regex job runs in a
 * worker_threads Worker, a pathological (catastrophic-backtracking) pattern is
 * terminated via worker.terminate() (never a hang), abort terminates the worker
 * and rejects with AbortError, ignore_case/literal/context/glob options, OEM vs
 * UTF-8 file content decoding for matching, and the 100-match cap / 60s scan
 * budget partial-result notices.
 */

const base = mkdtempSync(join(tmpdir(), "di-grep-"));
test.after(() => rmSync(base, { recursive: true, force: true }));

function write(relative: string, content = "") {
  const parts = relative.split("/");
  mkdirSync(join(base, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(base, ...parts), content, "utf8");
}

function writeBytes(relative: string, bytes: Uint8Array) {
  const parts = relative.split("/");
  mkdirSync(join(base, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(base, ...parts), bytes);
}

function run(args: unknown, signal?: AbortSignal, options?: GrepToolOptions) {
  return createGrepTool(base, options).execute(JSON.stringify(args), signal);
}

// ---- ported C# Di.Tests/Tools/GrepToolTests.cs ----

test("matches return file path, line number and content", async () => {
  write("a.txt", "alpha\nbeta\nalpha again");
  const obs = await run({ pattern: "alpha" });
  assert.equal(obs.isError, false);
  const lines = obs.text.split("\n");
  assert.ok(lines.includes("a.txt:1: alpha"), obs.text);
  assert.ok(lines.includes("a.txt:3: alpha again"), obs.text);
});

test("matches across files use per-file line numbers", async () => {
  write("a.txt", "x\nTODO\n");
  write("b.txt", "TODO\nx\n");
  const obs = await run({ pattern: "TODO" });
  const lines = obs.text.split("\n");
  assert.ok(lines.includes("a.txt:2: TODO"), obs.text);
  assert.ok(lines.includes("b.txt:1: TODO"), obs.text);
});

test("regex pattern supports complex matching", async () => {
  write("a.txt", "def handle_a():\n    pass\nclass Other:\n    pass");
  const obs = await run({ pattern: "def handle.*" });
  assert.ok(obs.text.includes("a.txt:1: def handle_a():"), obs.text);
  assert.ok(!obs.text.includes("class Other"), obs.text);
});

test("glob filter restricts files", async () => {
  write("src/a.py", "TODO\n");
  write("src/b.txt", "TODO\n");
  const obs = await run({ pattern: "TODO", glob: "**/*.py" });
  assert.ok(obs.text.includes("src/a.py"), obs.text);
  assert.ok(!obs.text.includes("b.txt"), obs.text);
});

test("path parameter scopes the search", async () => {
  write("src/a.py", "TODO\n");
  write("tests/b.py", "TODO\n");
  const obs = await run({ pattern: "TODO", path: "src" });
  assert.ok(obs.text.includes("a.py"), obs.text);
  assert.ok(!obs.text.includes("tests"), obs.text);
});

test("is case sensitive by default", async () => {
  write("a.txt", "TODO\ntodo\n");
  const obs = await run({ pattern: "TODO" });
  assert.ok(obs.text.includes("a.txt:1: TODO"), obs.text);
  assert.ok(!obs.text.includes("todo"), obs.text);
});

test("no match returns the not-found marker", async () => {
  write("a.txt", "nothing here");
  const obs = await run({ pattern: "zzz" });
  assert.ok(obs.text.includes("未找到"), obs.text);
});

test("invalid regex returns an error naming the regex", async () => {
  write("a.txt", "x");
  const obs = await run({ pattern: "[unclosed" });
  assert.ok(obs.isError, obs.text);
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("正则"), obs.text);
});

test("missing pattern returns an error naming pattern", async () => {
  const obs = await run({});
  assert.ok(obs.isError, obs.text);
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("pattern"), obs.text);
});

test("nonexistent path returns an error", async () => {
  const obs = await run({ pattern: "x", path: "nope" });
  assert.ok(obs.isError, obs.text);
  assert.ok(obs.text.startsWith("error:"), obs.text);
});

test("binary file with null bytes does not break the scan", async () => {
  writeBytes("bin.dat", Buffer.from([0, 0, 0, 1]));
  write("a.txt", "hit\n");
  const obs = await run({ pattern: "hit" });
  assert.ok(obs.text.includes("a.txt:1: hit"), obs.text);
});

test("oversized file is skipped but does not block smaller files", async () => {
  write("big.dat", "x".repeat(GREP_MAX_BYTES_FOR_TEST) + "hit\n");
  write("a.txt", "hit\n");
  const obs = await run({ pattern: "hit" });
  assert.ok(obs.text.includes("a.txt:1: hit"), obs.text);
});

test("oversized files are reported instead of silently skipped", async () => {
  write("big.dat", "x".repeat(GREP_MAX_BYTES_FOR_TEST) + "hit\n");
  const obs = await run({ pattern: "hit" });
  assert.ok(obs.text.includes("1 个文件超过 1 MiB 已跳过"), obs.text);
  assert.ok(obs.text.includes("big.dat"), obs.text);
  assert.ok(obs.text.includes("read_file 分段读取"), obs.text);
  assert.ok(!obs.text.includes("未找到"), obs.text);
});

test("multiple oversized files report the total count with a sample", async () => {
  // Scoped to its own directory so earlier tests' oversized files cannot change
  // the total (shared base).
  const big = "x".repeat(GREP_MAX_BYTES_FOR_TEST) + "hit\n";
  write("oversize/a.dat", big);
  write("oversize/b.dat", big);
  write("oversize/c.dat", big);
  write("oversize/d.dat", big);
  const obs = await run({ pattern: "hit", path: "oversize" });
  assert.ok(obs.text.includes("4 个文件超过 1 MiB 已跳过"), obs.text);
  assert.ok(obs.text.includes("a.dat"), obs.text);
  assert.ok(!obs.text.includes("d.dat"), obs.text);
});

test("result cap returns at most the default limit with a notice", async () => {
  write(
    "a.txt",
    Array.from({ length: GREP_DEFAULT_LIMIT + 20 }, (_, i) => `line ${i}`).join("\n"),
  );
  const obs = await run({ pattern: "line \\d+$" });
  const matchLines = obs.text.split("\n").filter((l) => l.startsWith("a.txt:"));
  assert.equal(matchLines.length, GREP_DEFAULT_LIMIT);
  assert.ok(obs.text.includes("100 条匹配上限"), obs.text);
});

test("invalid JSON arguments return an error", async () => {
  const obs = await createGrepTool(base).execute("nope");
  assert.ok(obs.isError, obs.text);
  assert.ok(obs.text.startsWith("error:"), obs.text);
});

test("definition has grep name and full schema", () => {
  const spec = createGrepTool(base).spec;
  assert.equal(spec.name, "grep");
  const props = spec.parameters.properties as Record<string, unknown>;
  assert.ok(props.pattern);
  assert.ok(props.path);
  assert.ok(props.glob);
  assert.ok(props.ignore_case);
  assert.ok(props.literal);
  assert.ok(props.context);
  assert.ok(props.limit);
  assert.deepEqual(spec.parameters.required, ["pattern"]);
});

test("path that is a file returns an error", async () => {
  write("file.txt", "hit\n");
  const obs = await run({ pattern: "hit", path: "file.txt" });
  assert.ok(obs.isError, obs.text);
  assert.ok(obs.text.includes("文件"), obs.text);
});

test("match at EOF without trailing newline is reported", async () => {
  write("a.txt", "hit");
  const obs = await run({ pattern: "hit" });
  assert.ok(obs.text.includes("a.txt:1: hit"), obs.text);
});

test("empty file returns not-found", async () => {
  // Scoped so the `.` pattern (matches any non-empty line) cannot hit leftover
  // files from earlier tests in the shared base.
  write("empty/a.txt", "");
  const obs = await run({ pattern: ".", path: "empty" });
  assert.ok(obs.text.includes("未找到"), obs.text);
});

test("unicode pattern matches unicode content", async () => {
  write("a.txt", "包含中文内容\nplain");
  const obs = await run({ pattern: "中文" });
  assert.ok(obs.text.includes("a.txt:1: 包含中文内容"), obs.text);
});

test("CRLF content has no carriage return in the matched line", async () => {
  write("a.txt", "one\r\nTODO\r\ntwo");
  const obs = await run({ pattern: "TODO" });
  assert.ok(obs.text.includes("a.txt:2: TODO"), obs.text);
  assert.ok(!obs.text.split("\n")[0]!.includes("\r"), obs.text);
});

test("long match line is truncated with a notice", async () => {
  write("a.txt", "x".repeat(5000) + "needle");
  const obs = await run({ pattern: "needle" });
  const line = obs.text.split("\n").find((l) => l.startsWith("a.txt:1: "));
  assert.ok(line, obs.text);
  assert.ok(line!.includes("[truncated]"), obs.text);
  assert.ok(obs.text.includes("已截断"), obs.text);
  assert.ok(obs.text.includes("read_file"), obs.text);
});

test("ignore_case option matches case-insensitively", async () => {
  write("a.txt", "TODO\ntodo\n");
  const obs = await run({ pattern: "todo", ignore_case: true });
  assert.ok(obs.text.includes("a.txt:1: TODO"), obs.text);
  assert.ok(obs.text.includes("a.txt:2: todo"), obs.text);
});

test("literal option treats the pattern as plain text", async () => {
  write("a.txt", "a.b\naxb\n");
  const obs = await run({ pattern: "a.b", literal: true });
  assert.ok(obs.text.includes("a.txt:1: a.b"), obs.text);
  assert.ok(!obs.text.includes("axb"), obs.text);
});

test("context option includes surrounding lines", async () => {
  write("a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven");
  const obs = await run({ pattern: "four", context: 2 });
  assert.ok(obs.text.includes("a.txt:4: four"), obs.text);
  assert.ok(obs.text.includes("a.txt-2- two"), obs.text);
  assert.ok(obs.text.includes("a.txt-3- three"), obs.text);
  assert.ok(obs.text.includes("a.txt-5- five"), obs.text);
  assert.ok(obs.text.includes("a.txt-6- six"), obs.text);
});

test("limit option stops early with a continuation notice", async () => {
  write("a.txt", Array.from({ length: 10 }, (_, i) => `hit ${i}`).join("\n"));
  const obs = await run({ pattern: "hit", limit: 3 });
  const matchLines = obs.text.split("\n").filter((l) => l.startsWith("a.txt:"));
  assert.equal(matchLines.length, 3);
  assert.ok(obs.text.includes("3 条匹配上限"), obs.text);
  assert.ok(obs.text.includes("limit=6"), obs.text);
});

test("anchored pattern matches the full line only", async () => {
  write("a.txt", "abc\nxabc\n");
  const obs = await run({ pattern: "^abc$" });
  assert.ok(obs.text.includes("a.txt:1: abc"), obs.text);
  assert.ok(!obs.text.includes("a.txt:2"), obs.text);
});

test("alternation pattern matches any branch", async () => {
  write("a.txt", "alpha\nbeta\ngamma");
  const obs = await run({ pattern: "alpha|gamma" });
  assert.ok(obs.text.includes("a.txt:1: alpha"), obs.text);
  assert.ok(obs.text.includes("a.txt:3: gamma"), obs.text);
  assert.ok(!obs.text.includes("beta"), obs.text);
});

test("pre-aborted signal rejects with AbortError", async () => {
  write("a.txt", "hit\n");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run({ pattern: "hit" }, controller.signal), { name: "AbortError" });
});

test("abort during the scan rejects with AbortError instead of completing", async () => {
  for (let i = 0; i < 600; i++) write(`abort-scan/f${i}.txt`, `hit ${i}\n`);
  const controller = new AbortController();
  const promise = run({ pattern: "hit", path: "abort-scan" }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(promise, { name: "AbortError" });
});

test("scan budget exceeded returns a partial-result notice instead of no-match", async () => {
  for (let i = 0; i < 1500; i++) write(`f${String(i).padStart(4, "0")}.txt`, `hit ${i}\n`);
  const obs = await run({ pattern: "hit" }, undefined, { scanBudgetMs: 1 });
  assert.ok(obs.text.includes("扫描超过"), obs.text);
  assert.ok(obs.text.includes("缩小 path/glob 范围"), obs.text);
  assert.ok(!obs.text.includes("未找到"), obs.text);
});

// ---- P4.3 worker-thread regex termination (P4-regex-probe) ----

test("pathological regex terminates via worker.terminate within a bounded time (Windows ReDoS evidence)", async () => {
  // (x+x+)+y against 30 x's + '!' is exponential in JS (>10s at n=28, probe §timeout).
  // A 500ms per-job timeout must terminate the worker and return — never hang.
  // Scoped to its own directory so leftover files from the scan-budget test do
  // not inflate the measured elapsed.
  write("re/bad.txt", "x".repeat(30) + "!");
  write("re/good.txt", "xxy\n"); // matches (x+x+)+y quickly, no backtracking

  const started = performance.now();
  const obs = await run({ pattern: "(x+x+)+y", path: "re" }, undefined, { regexTimeoutMs: 500 });
  const elapsed = performance.now() - started;

  assert.equal(obs.isError, false, obs.text);
  assert.ok(obs.text.includes("正则匹配超时"), `timeout notice missing: ${obs.text}`);
  assert.ok(obs.text.includes("bad.txt"), "timed-out file should be named as a sample");
  assert.ok(obs.text.includes("good.txt:1: xxy"), "worker rebuilt: later files still match");
  assert.ok(elapsed < 5000, `expected bounded return, took ${elapsed.toFixed(0)}ms`);
});

test("abort during a hanging regex job terminates the worker and rejects with AbortError", async () => {
  write("re-abort/bad.txt", "x".repeat(28) + "!");
  const controller = new AbortController();
  const started = performance.now();
  const promise = run(
    { pattern: "(x+x+)+y", path: "re-abort" },
    controller.signal,
    { regexTimeoutMs: 30_000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  controller.abort();
  await assert.rejects(promise, { name: "AbortError" });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5000, `abort should bound the hang, took ${elapsed.toFixed(0)}ms`);
});

// ---- .NET -> JS regex semantics (probe matrix) ----

test("\\p{L} Unicode property escapes work (u flag)", async () => {
  write("a.txt", "猫é\nabc");
  const obs = await run({ pattern: "\\p{L}+" });
  assert.ok(obs.text.includes("a.txt:1: 猫é"), obs.text);
});

test("\\A and \\z .NET anchors are bridged to ^ and $ for per-line matching", async () => {
  write("a.txt", "abc\nxabc\nabcy\n");
  const obsA = await run({ pattern: "\\Aabc" });
  assert.ok(obsA.text.includes("a.txt:1: abc"), obsA.text);
  assert.ok(!obsA.text.includes("a.txt:2"), obsA.text);
  const obsZ = await run({ pattern: "abc\\z" });
  assert.ok(obsZ.text.includes("a.txt:1: abc"), obsZ.text);
  assert.ok(!obsZ.text.includes("a.txt:3"), obsZ.text);
});

test(".NET-only regex syntax that JS rejects becomes an explicit error, not silent empty", async () => {
  write("a.txt", "abc");
  const obs = await run({ pattern: "(?'name'abc)" });
  assert.ok(obs.isError, obs.text);
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("正则"), obs.text);
});

test("trailing newline does not create a phantom empty match line", async () => {
  write("a.txt", "a\n\nb\n");
  const obs = await run({ pattern: "^$" });
  assert.ok(obs.text.includes("a.txt:2: "), obs.text); // the real empty line 2
  assert.ok(!obs.text.includes("a.txt:4"), obs.text); // no phantom line 4
});

test("UTF-8 BOM is stripped so the first line matches cleanly", async () => {
  write("bom.txt", "﻿hello\nworld");
  const obs = await run({ pattern: "^hello$" });
  assert.ok(obs.text.includes("bom.txt:1: hello"), obs.text);
});

// ---- content encoding for matching (P4-win-encoding-probe) ----

test("GBK (OEM 936) encoded content is matched via OEM decode", async () => {
  // "中文内容" in GBK bytes (verified via .NET GetEncoding(936)); strict UTF-8
  // fails -> OEM 936 (gbk) decode matches.
  writeBytes("gbk.txt", Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd]));
  const obs = await run({ pattern: "中文" }, undefined, { oemCodePage: 936 });
  assert.ok(obs.text.includes("gbk.txt:1: 中文内容"), obs.text);
});

// ---- edge args ----

test("context windows with close matches do not duplicate lines", async () => {
  // C# ScanWithContext dedup: hits at lines 3 and 4 with context 2 emit windows
  // [1..5] then [6..6]. The second match line (4) is rendered once as a context
  // line of the first window (`a.txt-4-`), never re-emitted with its own `:`.
  write("a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven");
  const obs = await run({ pattern: "three|four", context: 2 });
  const lines = obs.text.split("\n").filter((l) => l.startsWith("a.txt"));
  assert.ok(lines.includes("a.txt:3: three"), obs.text); // first match keeps `:` format
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  for (const [l, c] of counts) assert.equal(c, 1, `duplicate context line: ${l}`);
  for (const n of [1, 2, 4, 5, 6]) {
    assert.ok(lines.some((l) => l.startsWith(`a.txt-${n}-`)), `missing context line ${n}`);
  }
  assert.ok(!lines.some((l) => l.startsWith("a.txt-7")), "window should stop at line 6");
});

test("limit of zero clamps to one result (C# Math.Max(1, limit))", async () => {
  // Scoped so leftover "hit" files from the scan-budget test cannot satisfy the
  // clamp before this file does.
  write("clamp/a.txt", "hit\nhit\nhit\n");
  const obs = await run({ pattern: "hit", path: "clamp", limit: 0 });
  const matchLines = obs.text.split("\n").filter((l) => l.startsWith("a.txt:"));
  assert.equal(matchLines.length, 1);
  assert.ok(obs.text.includes("1 条匹配上限"), obs.text);
});

test("invalid context type returns an error naming context", async () => {
  const obs = await run({ pattern: "x", context: "two" });
  assert.ok(obs.isError, obs.text);
  assert.ok(obs.text.includes("context"), obs.text);
});

test("invalid ignore_case type returns an error naming ignore_case", async () => {
  const obs = await run({ pattern: "x", ignore_case: "yes" });
  assert.ok(obs.isError, obs.text);
  assert.ok(obs.text.includes("ignore_case"), obs.text);
});

test("invalid literal type returns an error naming literal", async () => {
  const obs = await run({ pattern: "x", literal: 1 });
  assert.ok(obs.isError, obs.text);
  assert.ok(obs.text.includes("literal"), obs.text);
});
