import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGrepTool, type GrepToolOptions } from "@di/coding-agent";

/**
 *
 * (and their negations `\W`/`\D`/`\B`, incl. inside character classes) to the
 *
 * `\d` is `\p{Nd}`, and `\b` is a word boundary between those classes.
 *
 * Fixtures: CJK (中文), fullwidth (ＡＢＣ), Arabic-Indic digit (٣, U+0663),
 * combining mark (U+0301), emoji separators. Assertions mirror the .NET
 *
 */

const base = mkdtempSync(join(tmpdir(), "di-grep-unicode-"));
test.after(() => rmSync(base, { recursive: true, force: true }));

function write(relative: string, content = "") {
  const parts = relative.split("/");
  mkdirSync(join(base, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(base, ...parts), content, "utf8");
}

function run(args: unknown, signal?: AbortSignal, options?: GrepToolOptions) {
  return createGrepTool(base, options).execute(JSON.stringify(args), signal);
}

// ---- \w: Unicode word class (letters + Mn marks + Nd digits + Pc + underscore) ----

test("\\w matches CJK, fullwidth letters and combining marks like .NET", async () => {
  write("words.txt", "中文\nＡＢＣ\né́\nabc_123\n!!!\n");
  const obs = await run({ pattern: "^\\w+$" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:1: 中文"), obs.text);
  assert.ok(lines.includes("words.txt:2: ＡＢＣ"), obs.text);
  assert.ok(lines.includes("words.txt:3: é́"), obs.text);
  assert.ok(lines.includes("words.txt:4: abc_123"), obs.text);
  assert.ok(!lines.some((l) => l.includes("words.txt:5")), `non-word line should not match: ${obs.text}`);
});

test("\\w inside a character class [\\w] is Unicode-aware", async () => {
  write("words.txt", "中文\nＡＢ\n7\nx!\n");
  const obs = await run({ pattern: "^[\\w]+$" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:1: 中文"), obs.text);
  assert.ok(lines.includes("words.txt:2: ＡＢ"), obs.text);
  assert.ok(lines.includes("words.txt:3: 7"), obs.text);
  assert.ok(!lines.some((l) => l.includes("words.txt:4")), obs.text);
});

test("\\w does not match non-word Unicode numbers (Nl/No) like .NET", async () => {
  write("words.txt", "Ⅻ\n²\nx\n");
  const obs = await run({ pattern: "^\\w$" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(!lines.some((l) => l.includes("Ⅻ")), obs.text);
  assert.ok(!lines.some((l) => l.includes("²")), obs.text);
});

// ---- \d: Unicode decimal digits (\p{Nd}) ----

test("\\d matches Arabic-Indic digits like .NET", async () => {
  write("words.txt", "٣\n7\nx\n");
  const obs = await run({ pattern: "^\\d$" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:1: ٣"), obs.text);
  assert.ok(lines.includes("words.txt:2: 7"), obs.text);
  assert.ok(!lines.some((l) => l.startsWith("words.txt:3")), obs.text);
});

test("\\d inside a character class [\\d] is Unicode-aware", async () => {
  write("words.txt", "٣\n7\nx\n");
  const obs = await run({ pattern: "^[\\d]$" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:1: ٣"), obs.text);
  assert.ok(lines.includes("words.txt:2: 7"), obs.text);
  assert.ok(!lines.some((l) => l.startsWith("words.txt:3")), obs.text);
});

// ---- \W / \D negations are Unicode-aware ----

test("\\W does not match CJK or Arabic-Indic digits (they are word chars in .NET)", async () => {
  write("words.txt", "猫\n٣\n!\n7\n");
  const obs = await run({ pattern: "^\\W$" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:3: !"), obs.text);
  assert.ok(!lines.some((l) => l.includes("猫")), obs.text);
  assert.ok(!lines.some((l) => l.includes("٣")), obs.text);
  assert.ok(!lines.some((l) => l.includes("7")), obs.text);
});

test("\\D does not match Arabic-Indic digits", async () => {
  write("words.txt", "٣\n!\nx\n");
  const obs = await run({ pattern: "^\\D$" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:2: !"), obs.text);
  assert.ok(lines.includes("words.txt:3: x"), obs.text);
  assert.ok(!lines.some((l) => l.includes("٣")), obs.text);
});

test("[\\W] inside a character class is Unicode-aware", async () => {
  write("words.txt", "猫\n!\n");
  const obs = await run({ pattern: "^[\\W]$" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:2: !"), obs.text);
  assert.ok(!lines.some((l) => l.includes("猫")), obs.text);
});

test("[\\D] inside a character class is Unicode-aware", async () => {
  write("words.txt", "٣\n!\n");
  const obs = await run({ pattern: "^[\\D]$" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:2: !"), obs.text);
  assert.ok(!lines.some((l) => l.includes("٣")), obs.text);
});

test("[^^\\W] (negated class with a literal caret plus \\W) keeps .NET semantics", async () => {
  // .NET [^^\W] = ¬(^ ∪ ¬word) = word chars except the literal caret.
  write("words.txt", "^\n猫\na\n!\n");
  const obs = await run({ pattern: "^[^^\\W]$" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:2: 猫"), obs.text);
  assert.ok(lines.includes("words.txt:3: a"), obs.text);
  assert.ok(!lines.some((l) => l.startsWith("words.txt:1")), obs.text);
  assert.ok(!lines.some((l) => l.startsWith("words.txt:4")), obs.text);
});

// ---- \b / \B: Unicode word boundaries ----

test("\\b boundaries hold around CJK like .NET", async () => {
  write("words.txt", "中文\nx中文x\n");
  const obs = await run({ pattern: "\\b中文\\b" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:1: 中文"), obs.text);
  assert.ok(!lines.some((l) => l.includes("words.txt:2")), obs.text);
});

test("\\b boundaries hold around fullwidth letters like .NET", async () => {
  write("words.txt", "ＡＢ\nxＡＢ\n");
  const obs = await run({ pattern: "\\bＡＢ\\b" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:1: ＡＢ"), obs.text);
  assert.ok(!lines.some((l) => l.includes("words.txt:2")), obs.text);
});

test("\\B is a non-boundary between two CJK chars like .NET", async () => {
  write("words.txt", "中文\n");
  const obs = await run({ pattern: "^中\\B文$" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:1: 中文"), obs.text);
});

test("[\\b] inside a character class remains the backspace escape, not a boundary", async () => {
  write("words.txt", "\u0008\nx\n");
  const obs = await run({ pattern: "[\\b]" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:1: \u0008"), obs.text);
  assert.ok(!lines.some((l) => l.includes("words.txt:2")), obs.text);
});

// ---- composition: ignore_case + anchors still work alongside Unicode classes ----

test("ignore_case composes with Unicode \\w (CJK is a word char)", async () => {
  write("words.txt", "TODO猫\n");
  const obs = await run({ pattern: "todo\\w", ignore_case: true });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:1: TODO猫"), obs.text);
});

test("\\A and \\z anchors are still bridged to ^ and $", async () => {
  write("words.txt", "abc\nxabc\nabcy\n");
  const obs = await run({ pattern: "\\Aabc\\z" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:1: abc"), obs.text);
  assert.ok(!lines.some((l) => l.includes("words.txt:2")), obs.text);
  assert.ok(!lines.some((l) => l.includes("words.txt:3")), obs.text);
});

// ---- guard rails: .NET-only syntax stays an explicit error, never silent ----

test("\\p{IsScript} .NET syntax stays an explicit error (not a silent literal)", async () => {
  write("words.txt", "α\n");
  const obs = await run({ pattern: "\\p{IsGreek}+" });
  assert.ok(obs.isError, obs.text);
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("正则"), obs.text);
});

test("escaped backslashes before a class letter are not translated (\\\\w is literal backslash + w)", async () => {
  write("words.txt", "w\n\\w\n猫\n");
  const obs = await run({ pattern: "\\\\w" });
  assert.equal(obs.isError, false, obs.text);
  const lines = obs.text.split("\n").filter((l) => l.startsWith("words.txt:"));
  assert.ok(lines.includes("words.txt:2: \\w"), obs.text);
  assert.ok(!lines.some((l) => l.includes("words.txt:1")), obs.text);
  assert.ok(!lines.some((l) => l.includes("猫")), obs.text);
});
