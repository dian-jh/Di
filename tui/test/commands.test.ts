/**
 * 斜杠命令归一化纯函数测试：命令名/参数拆分 + `skill:` 前缀（补全插入形态）→ 后端 `/skill <名> [参数]`。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeSlash } from "../src/app/commands.ts";

describe("normalizeSlash：命令名与参数拆分", () => {
  it("带参数的命令", () => {
    assert.deepEqual(normalizeSlash("/model deepseek-v4-pro"), { name: "model", args: "deepseek-v4-pro" });
  });

  it("无参数的命令", () => {
    assert.deepEqual(normalizeSlash("/model"), { name: "model", args: "" });
  });

  it("参数两侧空白被裁剪", () => {
    assert.deepEqual(normalizeSlash("/clear   "), { name: "clear", args: "" });
    assert.deepEqual(normalizeSlash("/skill  x  y "), { name: "skill", args: "x  y" });
  });
});

describe("normalizeSlash：skill: 前缀归一（补全插入形态）", () => {
  it("`/skill:name` → 后端 `/skill name`", () => {
    assert.deepEqual(normalizeSlash("/skill:code-review"), { name: "skill", args: "code-review" });
  });

  it("`/skill:name 参数` → 后端 `/skill name 参数`", () => {
    assert.deepEqual(normalizeSlash("/skill:code-review 修复 x"), { name: "skill", args: "code-review 修复 x" });
  });

  it("空 skill 名保持原样（交给后端报 unknown_command）", () => {
    assert.deepEqual(normalizeSlash("/skill:"), { name: "skill:", args: "" });
  });
});