import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  SkillFormatError,
  parseSkillMarkdown,
} from "@di/coding-agent";

/**
 * P6.2a unit 1 — frontmatter. Mirrors `Di.Tests/Skills/SkillMarkdownTests.cs` and
 * `Core/Skills/SkillMarkdown.cs` at baseline 09f4e08. The C# baseline parses
 * frontmatter with a hand-rolled single-line / single-level parser (NOT a YAML
 * library), so the TS port must pin exactly the same accepted / ignored /
 * rejected format set — "supported formats must not silently change because the
 * YAML library differs".
 */

test("parse extracts name, description and instructions", () => {
  const skill = parseSkillMarkdown(
    "---\n" +
      "name: backend-tests\n" +
      "description: 运行并修复后端测试\n" +
      "---\n" +
      "运行 dotnet test 的工作流：改代码后先 build 再 test。",
    "backend-tests",
  );
  assert.equal(skill.name, "backend-tests");
  assert.equal(skill.description, "运行并修复后端测试");
  assert.match(skill.instructions, /先 build 再 test/);
});

test("values may contain colons and quotes", () => {
  const skill = parseSkillMarkdown('---\nname: deploy\ndescription: "部署到 staging: 先 build"\n---\nbody');
  assert.equal(skill.name, "deploy");
  assert.equal(skill.description, "部署到 staging: 先 build");
});

test("unquoted values keep internal colons (split at first colon)", () => {
  const skill = parseSkillMarkdown("---\nname: x\ndescription: 部署到 staging: 先 build\n---\nbody");
  assert.equal(skill.description, "部署到 staging: 先 build");
});

test("leading BOM and blank lines are tolerated", () => {
  const skill = parseSkillMarkdown("﻿\n\n---\nname: x\ndescription: y\n---\nbody");
  assert.equal(skill.name, "x");
  assert.equal(skill.instructions, "body");
});

test("Windows CRLF is handled", () => {
  const skill = parseSkillMarkdown("---\r\nname: win\r\ndescription: crlf 文件\r\n---\r\nline1\r\nline2");
  assert.equal(skill.name, "win");
  assert.match(skill.instructions, /line1/);
  assert.match(skill.instructions, /line2/);
});

test("nested metadata is parsed", () => {
  const skill = parseSkillMarkdown("---\nname: x\ndescription: y\nmetadata:\n  author: contoso\n  version: \"2.1\"\n---\nbody");
  assert.equal(skill.metadata["author"], "contoso");
  assert.equal(skill.metadata["version"], "2.1");
});

test("metadata duplicate key keeps the first value", () => {
  const skill = parseSkillMarkdown("---\nname: x\ndescription: y\nmetadata:\n  author: first\n  author: second\n---\nbody");
  assert.equal(skill.metadata["author"], "first");
});

test("allowed-tools is space delimited", () => {
  const skill = parseSkillMarkdown("---\nname: x\ndescription: y\nallowed-tools: read_file write_file\n---\nbody");
  assert.deepEqual([...skill.allowedTools], ["read_file", "write_file"]);
});

test("disable-model-invocation true/false is case-insensitive", () => {
  const on = parseSkillMarkdown("---\nname: x\ndescription: y\ndisable-model-invocation: true\n---\nbody");
  assert.equal(on.disableModelInvocation, true);
  const off = parseSkillMarkdown("---\nname: x\ndescription: y\n---\nbody");
  assert.equal(off.disableModelInvocation, false);
  const explicitOff = parseSkillMarkdown("---\nname: x\ndescription: y\ndisable-model-invocation: false\n---\nbody");
  assert.equal(explicitOff.disableModelInvocation, false);
  const upper = parseSkillMarkdown("---\nname: x\ndescription: y\ndisable-model-invocation: TRUE\n---\nbody");
  assert.equal(upper.disableModelInvocation, true);
});

test("unknown top-level fields are ignored", () => {
  const skill = parseSkillMarkdown("---\nname: x\ndescription: y\nunknown-field: whatever\n---\nbody");
  assert.equal(skill.name, "x");
  assert.equal(Object.keys(skill.metadata).length, 0);
  assert.deepEqual([...skill.allowedTools], []);
});

test("license and compatibility are tolerated and ignored", () => {
  const skill = parseSkillMarkdown("---\nname: x\ndescription: y\nlicense: MIT\ncompatibility: windows/linux\n---\nbody");
  assert.equal(skill.name, "x");
  assert.equal(skill.description, "y");
});

test("comments in frontmatter are ignored", () => {
  const skill = parseSkillMarkdown("---\n# 这是注释\nname: x\ndescription: y\n---\nbody");
  assert.equal(skill.name, "x");
});

test("inline-flow metadata is NOT parsed (pins the C# single-level parser boundary)", () => {
  // A YAML library would parse `metadata: {author: contoso}` into a map; the C#
  // baseline treats the non-empty value as an unknown field and ignores it. The
  // TS port pins the C# boundary so supported formats do not silently change.
  const skill = parseSkillMarkdown("---\nname: x\ndescription: y\nmetadata: {author: contoso}\n---\nbody");
  assert.equal(Object.keys(skill.metadata).length, 0);
});

test("name mismatching directory throws", () => {
  assert.throws(
    () => parseSkillMarkdown("---\nname: x\ndescription: y\n---\nbody", "other"),
    (err: unknown) => {
      assert.ok(err instanceof SkillFormatError);
      assert.match((err as SkillFormatError).message, /目录名/);
      return true;
    },
  );
});

test("invalid name format throws", () => {
  assert.throws(() => parseSkillMarkdown("---\nname: BadName\ndescription: y\n---\nbody"), SkillFormatError);
  assert.throws(() => parseSkillMarkdown("---\nname: -bad\ndescription: y\n---\nbody"), SkillFormatError);
  assert.throws(() => parseSkillMarkdown("---\nname: bad--name\ndescription: y\n---\nbody"), SkillFormatError);
});

test("overlong name throws", () => {
  const longName = "a".repeat(MAX_SKILL_NAME_LENGTH + 1);
  assert.throws(() => parseSkillMarkdown(`---\nname: ${longName}\ndescription: y\n---\nbody`), SkillFormatError);
});

test("overlong description throws", () => {
  const longDesc = "中".repeat(MAX_SKILL_DESCRIPTION_LENGTH + 1);
  assert.throws(() => parseSkillMarkdown(`---\nname: x\ndescription: ${longDesc}\n---\nbody`), SkillFormatError);
});

test("duplicate recognized field throws", () => {
  assert.throws(
    () => parseSkillMarkdown("---\nname: x\nname: y\ndescription: z\n---\nbody"),
    (err: unknown) => {
      assert.ok(err instanceof SkillFormatError);
      assert.match((err as SkillFormatError).message, /重复/);
      return true;
    },
  );
});

test("missing frontmatter throws", () => {
  assert.throws(
    () => parseSkillMarkdown("没有 frontmatter"),
    (err: unknown) => {
      assert.ok(err instanceof SkillFormatError);
      assert.match((err as SkillFormatError).message, /---/);
      return true;
    },
  );
});

test("unclosed frontmatter throws", () => {
  assert.throws(() => parseSkillMarkdown("---\nname: x\ndescription: y\nbody"), SkillFormatError);
});

test("missing name throws", () => {
  assert.throws(() => parseSkillMarkdown("---\ndescription: y\n---\nbody"), SkillFormatError);
});

test("missing description throws", () => {
  assert.throws(() => parseSkillMarkdown("---\nname: x\n---\nbody"), SkillFormatError);
});

test("empty body throws", () => {
  assert.throws(() => parseSkillMarkdown("---\nname: x\ndescription: y\n---\n\n"), SkillFormatError);
});
