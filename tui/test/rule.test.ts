/**
 * Rule（白色分隔线）组件测试 + 模块加载回归。
 *
 * 回归背景：chat-view.ts / rule.ts 在模块级调用 parseColor()（import 时即执行）。pi-tui 的
 * parseColor 不接受命名色（如 "white"，只吃数字/hex/oklch/okhsl），曾导致 TUI 启动即崩
 * 溃并回退 REPL。此处导入两个模块即触发模块级构造，颜色非法会直接抛错。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

// 模块级 editorTheme 构造（含 parseColor）——颜色值非法时此处 import 即抛错。
import "../src/app/chat-view.ts";
import { Rule } from "../src/app/rule.ts";

describe("Rule：浅灰框线", () => {
  it("按渲染宽度绘制一条全宽 ─ 线（默认浅灰）", () => {
    const rule = new Rule();
    for (const width of [10, 40, 80]) {
      const lines = rule.render(width);
      assert.equal(lines.length, 1, `宽度 ${width} 应渲染单行`);
      assert.equal(stripTerminalSequences(lines[0]!), "─".repeat(width), `宽度 ${width} 可见宽度应恰为 ${width}`);
    }
  });

  it("可指定颜色（hex）", () => {
    const rule = new Rule("#ff0000");
    assert.equal(stripTerminalSequences(rule.render(8)[0]!), "─".repeat(8));
  });

  it("窄宽度（0）不产生越界", () => {
    const rule = new Rule();
    const lines = rule.render(0);
    assert.equal(lines.length, 1);
    assert.equal(stripTerminalSequences(lines[0]!), "");
  });
});