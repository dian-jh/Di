/**
 * BadgedEditor 单元测试：模型徽标渲染在输入框下方独立一行（右对齐），
 * 不与输入框（含其边框）同处一行。用假 Editor 目标（structurally 满足
 * BadgedTarget），不依赖真实终端。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { BadgedEditor, type BadgedTarget } from "../src/app/badge.ts";

class FakeEditor implements BadgedTarget {
  showing = false;
  private readonly lines: string[];

  constructor(lines: string[]) {
    this.lines = lines;
  }

  render(_width: number): string[] {
    return [...this.lines];
  }

  invalidate(): void {}

  isShowingAutocomplete(): boolean {
    return this.showing;
  }

  handleInput(_data: string): void {}

  handleMouse(): undefined {
    return undefined;
  }
}

describe("BadgedEditor：输入框下方独立徽标行", () => {
  it("无徽标 → 原样透传", () => {
    const badge = new BadgedEditor(new FakeEditor(["a", "b"]));
    assert.deepEqual(badge.render(10), ["a", "b"]);
  });

  it("徽标独立成行：输入框行不动，末尾追加右对齐徽标行", () => {
    const badge = new BadgedEditor(new FakeEditor(["content", "─".repeat(40)]));
    badge.setBadge("deepseek-flash · high");

    const out = badge.render(40);
    assert.equal(out.length, 3, "输入框两行 + 徽标独立一行");
    assert.equal(stripTerminalSequences(out[0]!), "content", "内容行不受影响");
    assert.equal(stripTerminalSequences(out[1]!), "─".repeat(40), "输入框边框行不受影响（不与徽标同处一行）");
    const last = stripTerminalSequences(out[2]!);
    assert.equal(last.length, 40, "徽标行整行可见宽度为终端宽度");
    assert.ok(last.endsWith("deepseek-flash · high"), `徽标应右对齐在独立行的最右端：${JSON.stringify(last)}`);
  });

  it("自动补全菜单展开时跳过徽标行（菜单收起后恢复）", () => {
    const target = new FakeEditor(["a", "b"]);
    target.showing = true;
    const badge = new BadgedEditor(target);
    badge.setBadge("deepseek-flash · high");
    assert.deepEqual(badge.render(10), ["a", "b"]);
  });

  it("终端太窄放不下徽标 → 原样透传", () => {
    const badge = new BadgedEditor(new FakeEditor(["─".repeat(5)]));
    badge.setBadge("deepseek-flash · high");
    const out = badge.render(5);
    assert.equal(stripTerminalSequences(out[0]!), "─".repeat(5));
  });
});