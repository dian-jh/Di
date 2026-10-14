/**
 * 消息组件测试：用户消息自带浅灰条形框（上/下框线，区分非用户输入）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { SystemMessage, UserMessage } from "../src/app/message.ts";

describe("UserMessage：浅灰条形框", () => {
  it("内容上下各有全宽框线", () => {
    const lines = new UserMessage("你好").render(20);
    assert.equal(lines.length, 3, "上框线 + 内容 + 下框线");
    assert.equal(stripTerminalSequences(lines[0]!), "─".repeat(20));
    assert.equal(stripTerminalSequences(lines[2]!), "─".repeat(20));
    assert.ok(stripTerminalSequences(lines[1]!).includes("❯ 你好"), "内容带 ❯ 前缀");
  });
});

describe("SystemMessage：无框系统应答", () => {
  it("按行加 ‖ 前缀，无框线", () => {
    const lines = new SystemMessage("a\nb").render(20);
    assert.equal(lines.length, 2);
    assert.ok(stripTerminalSequences(lines[0]!).includes("‖ a"));
    assert.ok(stripTerminalSequences(lines[1]!).includes("‖ b"));
  });
});