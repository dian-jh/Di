/**
 * createChatLayout 单元测试：全屏 alt-screen 视口 + 底部固定 dock。
 *
 * 回归背景：输入框要"一直默认在终端底部"，必须脱离 TuiMainScreen 的 inline 自然滚动
 * （内容超过终端高度后输入框随文档流离开视口），改为 Pi coding-agent 同构的全屏视口
 * 布局：root = VStack[transcript ScrollView(follow end, grow) + dock(basis auto)]。
 * ScrollView 的 follow:"end" 每帧把滚动位置重新钉到底部（scroll-view.js updateLayout）。
 * 此处只测纯函数式装配（组件树、选项、空文案塌缩），不依赖真实终端。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Container, ScrollView, Text, VStack } from "@earendil-works/pi-tui";

import { createChatLayout, type ChatLayoutParts } from "../src/app/chat-layout.ts";

function build(parts?: Partial<ChatLayoutParts>) {
  const transcript = new Container();
  const banner = new Text("", 1, 0);
  const status = new Text("", 1, 0);
  const editor = new Text("", 1, 0);
  const layout = createChatLayout({ transcript, banner, status, editor, ...parts });
  return { transcript, banner, status, editor, ...layout };
}

describe("createChatLayout：全屏视口 + 底部固定 dock", () => {
  it("transcript 包进 follow-end 主滚动视口（primary、链式 overscroll、auto 滚动条）", () => {
    const { transcriptScroll } = build();
    assert.ok(transcriptScroll instanceof ScrollView);
    assert.equal(transcriptScroll.followEnd, true, "新内容到达后应自动跟随到底部");
    assert.equal(transcriptScroll.primary, true, "作为 alt-screen 主滚动视图（滚轮/翻页落到它）");
    assert.equal(transcriptScroll.overscroll, "chain");
    assert.equal(transcriptScroll.scrollbar, "auto");
  });

  it("根 VStack：transcript 滚动区在上，dock 在下", () => {
    const l = build();
    assert.ok(l.root instanceof VStack);
    assert.ok(l.dock instanceof VStack);
    assert.deepEqual(l.root.children, [l.transcriptScroll, l.dock]);
  });

  it("dock 顺序 = [banner, status, editor]；输入组件始终最后（贴着终端底部）", () => {
    const l = build();
    assert.deepEqual(l.dock.children, [l.banner, l.status, l.editor]);
  });

  it("空文案状态行/横幅塌缩：dock 高度只剩输入槽的 minSize 保护行（不挤占）", () => {
    const l = build();
    const dockLines = l.dock.render(80);
    // Text("") 渲染 0 行；editor minSize:1 保证输入槽在空输入时至少占 1 行（真实 Editor 自带边框行数更高）。
    assert.equal(dockLines.length, Math.max(1, l.editor.render(80).length), "空 banner/status 不应给 dock 增加行");
  });

  it("非空状态行排在编辑器上方（统计行在输入框上面，不遮挡）", () => {
    const status = new Text("1 轮 · tokens: in=10", 1, 0);
    const l = build({ status });
    const dockLines = l.dock.render(80);
    const statusRow = dockLines.findIndex((line) => line.includes("1 轮 · tokens: in=10"));
    assert.ok(statusRow !== -1, "状态行文本应出现在 dock 渲染结果中");
    assert.ok(statusRow < dockLines.length - 1, "状态行应在编辑器行之前");
  });

  it("transcript 内容经滚动视口渲染（ScrollView 包裹文档容器）", () => {
    const { transcript, transcriptScroll } = build();
    transcript.addChild(new Text("hello", 1, 0));
    const lines = transcriptScroll.render(10);
    assert.ok(lines.some((l) => l.includes("hello")), "文档内容应能透过滚动视口渲染出");
  });
});