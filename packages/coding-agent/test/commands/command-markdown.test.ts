import test from "node:test";
import assert from "node:assert/strict";
import { CommandFormatException, parseCommandMarkdown } from "@di/coding-agent";

/**
 * P6.3a card — user-command Markdown (port of C# `CommandMarkdownTests.cs`):
 * `~/.di/commands/<name>.md` frontmatter strictness mirrors `SkillMarkdownTests`
 * (required field / duplicate field / unknown field / BOM-CRLF).
 */

test("parse happy path", () => {
  const cmd = parseCommandMarkdown(
    `---
description: 提交当前改动
argument-hint: 提交信息
---
运行 git add -A 并提交。
`,
    "commit",
  );

  assert.equal(cmd.name, "commit");
  assert.equal(cmd.description, "提交当前改动");
  assert.equal(cmd.argumentHint, "提交信息");
  assert.equal(cmd.body, "运行 git add -A 并提交。");
});

test("parse no argument hint is undefined", () => {
  const cmd = parseCommandMarkdown(
    `---
description: 清理临时文件
---
rm -rf 临时目录。
`,
    "cleanup",
  );

  assert.equal(cmd.argumentHint, undefined);
  assert.equal(cmd.description, "清理临时文件");
});

test("parse missing frontmatter throws", () => {
  assert.throws(() => parseCommandMarkdown("hello", "hello"), CommandFormatException);
});

test("parse unclosed frontmatter throws", () => {
  assert.throws(() => parseCommandMarkdown("---\ndescription: hi\n", "hello"), CommandFormatException);
});

test("parse missing description throws", () => {
  assert.throws(() => parseCommandMarkdown("---\nargument-hint: x\n---\nbody", "hello"), CommandFormatException);
});

test("parse empty body throws", () => {
  assert.throws(() => parseCommandMarkdown("---\ndescription: hi\n---\n  ", "hello"), CommandFormatException);
});

test("parse invalid name throws", () => {
  // command name = file name, must match the lowercase/letters/digits/hyphen rule.
  assert.throws(() => parseCommandMarkdown("---\ndescription: hi\n---\nbody", "BadName"), CommandFormatException);
  assert.throws(() => parseCommandMarkdown("---\ndescription: hi\n---\nbody", "-bad"), CommandFormatException);
});

test("parse duplicate description throws", () => {
  assert.throws(
    () => parseCommandMarkdown("---\ndescription: a\ndescription: b\n---\nbody", "hello"),
    CommandFormatException,
  );
});

test("parse unknown fields ignored", () => {
  const cmd = parseCommandMarkdown("---\ndescription: hi\nlicense: MIT\nname: 不应覆盖\n---\nbody", "hello");

  assert.equal(cmd.description, "hi");
  assert.equal(cmd.name, "hello"); // the command name always comes from the file name
});

test("parse BOM and CRLF tolerated", () => {
  const cmd = parseCommandMarkdown("﻿\r\n---\r\ndescription: hi\r\n---\r\nbody\r\n", "hello");

  assert.equal(cmd.description, "hi");
  assert.equal(cmd.body, "body");
});

test("parse description with colons and quotes kept", () => {
  const cmd = parseCommandMarkdown('---\ndescription: "发 PR：引用 #42"\n---\nbody', "hello");

  assert.equal(cmd.description, "发 PR：引用 #42");
});
