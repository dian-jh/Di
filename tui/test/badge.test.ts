/**
 * BadgedEditor 单元测试：模型徽标合成到输入框底部边框右下角。
 * 用假 Editor 目标（structurally 满足 BadgedTarget），不依赖真实终端。
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

describe("BadgedEditor：输入框右下角模型徽标", () => {
  it("无徽标 → 原样透传", () => {
    const badge = new BadgedEditor(new FakeEditor(["a", "b"]));
    assert.deepEqual(badge.render(10), ["a", "b"]);
  });

  it("徽标右对齐合成到底部边框行的右下角", () => {
    const badge = new BadgedEditor(new FakeEditor(["content", "─".repeat(40)]));
    badge.setBadge("deepseek-flash · high");

    const out = badge.render(40);
    assert.equal(out.length, 2);
    const last = stripTerminalSequences(out[1]!);
    assert.equal(last.length, 40, "合成后整行可见宽度不变");
    assert.ok(last.endsWith("deepseek-flash · high"), `徽标应右对齐在末行：${JSON.stringify(last)}`);
    assert.equal(stripTerminalSequences(out[0]!), "content", "内容行不受影响");
  });

  it("自动补全菜单展开时跳过合成（最后一行是菜单项）", () => {
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