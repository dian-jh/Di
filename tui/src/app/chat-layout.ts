/**
 * 全屏聊天视口装配（对齐 Pi coding-agent 的 createChatViewport，chat-viewport.ts）：
 * root = VStack[ transcript ScrollView(follow end, basis 0, grow 1) + dock(basis auto) ]。
 *
 * - transcript 包进 ScrollView：内容超出视口后在定高区域内滚动；follow:"end" 让新消息
 *   到达时每帧重新钉到底部（pi-tui scroll-view.js updateLayout），input 永远不会被顶走。
 * - dock 固定在底部：banner/status 空文案时 Text 渲染 0 行自动塌缩，输入框始终贴着
 *   终端最后一行。
 * - 滚轮 / PgUp / PgDn / Ctrl+Home / Ctrl+End 等视口滚动由 TuiAltScreen 内置处理
 *   （tui.altScreen.* 键位 + parseWheelEvent/routeWheel），落到 primary ScrollView（本布局）。
 *
 * 纯函数装配：不持有终端、不注册事件，可脱离 TUI 单测（见 chat-layout.test.ts）。
 */

import { Container, ScrollView, Text, VStack, type Component } from "@earendil-works/pi-tui";

export interface ChatLayoutParts {
  /** 消息区文档（追加对话框的容器，长内容由 ScrollView 负责滚动）。 */
  transcript: Container;
  /** 错误横幅（空文案塌缩，不占 dock 高度）。 */
  banner: Component;
  /** 左-底部状态行（空文案塌缩；回合统计/运行提示）。 */
  status: Component;
  /** 输入组件（带模型徽标的 BadgedEditor 包装亦满足 Component）。 */
  editor: Component;
}

export interface ChatLayout {
  /** 包裹 transcript 的主滚动视口（follow end + primary）。 */
  transcriptScroll: ScrollView;
  /** 底部固定区域：[banner, status, editor]，basis auto 取固有高度。 */
  dock: VStack;
  /** 布局根：交给 TuiAltScreen.setLayoutRoot（布局引擎按 terminal.rows 分配合法高度）。 */
  root: VStack;
}

export function createChatLayout(parts: ChatLayoutParts): ChatLayout {
  const transcriptScroll = new ScrollView(parts.transcript, {
    follow: "end",
    primary: true,
    overscroll: "chain",
    scrollbar: "auto",
  });
  // dock 按固有高度占位（basis auto）；终端变矮时 shrink 收紧凑、minSize 保护输入框可见。
  const dock = new VStack([
    { component: parts.banner, shrink: 1, minSize: 0 },
    { component: parts.status, shrink: 1, minSize: 0 },
    { component: parts.editor, shrink: 1, minSize: 1 },
  ]);
  const root = new VStack([
    { component: transcriptScroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  return { transcriptScroll, dock, root };
}