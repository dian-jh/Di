/**
 * 聊天消息组件：
 * - UserMessage：用户消息（`❯` 前缀）。
 * - AssistantMessage：推理区（有内容才渲染）+ 工具调用行 + 流式答案。
 *
 * 流式答案 M1 用纯 Text（自动换行、无格式），避免半成品 Markdown 渲染抖动；
 * Markdown 主题化属于 M2/M3。
 */

import { Container, Markdown, Text, type Component, parseColor, styleText, getTerminalColorMode, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { ToolCallView } from "./tool-call.ts";
import type { ToolCallEntry } from "./state.ts";
import { registerFoldItem } from "./fold-navigation.ts";
import { SpacedBlock } from "./spacing.ts";

let latestReasoningFold: FoldableText | undefined;
const turnGroups: TurnGroup[] = [];
let selectedTurnGroup = -1;
export function toggleLatestReasoning(): void { latestReasoningFold?.toggle(); }
export function toggleLatestTurnGroup(): void { if (selectedTurnGroup < 0) selectedTurnGroup = turnGroups.length - 1; turnGroups[selectedTurnGroup]?.toggle(); }
export function cycleTurnGroup(delta: number): void {
  if (turnGroups.length === 0) return;
  selectedTurnGroup = (selectedTurnGroup + delta + turnGroups.length) % turnGroups.length;
  turnGroups.forEach((group, index) => group.setSelected(index === selectedTurnGroup));
}

/** 用户消息整行灰底，前缀与正文使用高对比浅色。 */
const colorMode = getTerminalColorMode();
const gray = parseColor("#a0a0a0");
const userBg = parseColor("#373737");
const userFg = parseColor("#f2f2f2");
const markdownTheme = {
  heading: (s: string) => styleText(s, { bold: true }, colorMode), link: (s: string) => styleText(s, { fg: parseColor("#6cb6ff"), underline: true }, colorMode),
  linkUrl: (s: string) => styleText(s, { fg: gray }, colorMode), code: (s: string) => styleText(s, { fg: parseColor("#e5c07b") }, colorMode),
  codeBlock: (s: string) => styleText(s, { fg: parseColor("#d0d0d0") }, colorMode), codeBlockBorder: (s: string) => styleText(s, { fg: gray }, colorMode),
  quote: (s: string) => styleText(s, { fg: gray }, colorMode), quoteBorder: (s: string) => styleText(s, { fg: gray }, colorMode),
  hr: (s: string) => styleText(s, { fg: gray }, colorMode), listBullet: (s: string) => s, bold: (s: string) => styleText(s, { bold: true }, colorMode),
  italic: (s: string) => styleText(s, { italic: true }, colorMode), strikethrough: (s: string) => styleText(s, { strikethrough: true }, colorMode), underline: (s: string) => styleText(s, { underline: true }, colorMode),
  highlightCode: (code: string, lang?: string) => {
    if (lang?.toLowerCase() !== "diff") return code.split("\n");
    return code.split("\n").map((line) => line.startsWith("+") && !line.startsWith("+++")
      ? styleText(line, { fg: parseColor("#c8e6c9"), bg: parseColor("#1b5e20") }, colorMode)
      : line.startsWith("-") && !line.startsWith("---")
        ? styleText(line, { fg: parseColor("#ffcdd2"), bg: parseColor("#7f1d1d") }, colorMode)
        : line);
  },
};

export class UserMessage extends Container {
  constructor(content: string) {
    super();
    this.addChild(new UserMessageBody(content));
  }
}

class UserMessageBody implements Component {
  private readonly text: Text;
  constructor(content: string) {
    this.text = new Text(content.split("\n").map((line, i) => `${i === 0 ? "> " : "  "}${line}`).join("\n"), 0, 0,
      (s) => styleText(s, { fg: userFg }, colorMode));
  }
  render(width: number): string[] {
    return this.text.render(width).map((line) => {
      const pad = Math.max(0, width - visibleWidth(line));
      return styleText(line + " ".repeat(pad), { fg: userFg, bg: userBg }, colorMode);
    });
  }
  invalidate(): void { this.text.invalidate(); }
}

/** 斜杠命令应答：以 `‖ ` 前缀的多行系统消息。 */
export class SystemMessage extends Container {
  constructor(content: string) {
    super();
    this.addChild(new Text(content.split("\n").map((line) => `‖ ${line}`).join("\n"), 1, 0));
  }
}

/** 一个历史回合的独立折叠容器；header 点击或聚焦后 Enter/Space 仅切换本回合。 */
export class TurnGroup implements Component {
  private expanded = true;
  private selected = false;
  private readonly header: Text;
  readonly children: Component[];
  readonly label: string;
  constructor(children: Component[], label: string) {
    this.children = children;
    this.label = label;
    this.selected = true;
    this.header = new Text(`● ⌄ ${label} (Ctrl+O)`, 1, 0, (s) => styleText(s, { fg: gray }, colorMode));
    turnGroups.push(this);
    selectedTurnGroup = turnGroups.length - 1;
    registerFoldItem({ toggle: () => this.toggle(), select: (selected) => this.setSelected(selected) });
  }
  render(width: number): string[] {
    const lines: string[] = [];
    if (this.expanded) for (const child of this.children) lines.push(...child.render(width));
    return lines;
  }
  invalidate(): void { this.header.invalidate(); for (const child of this.children) child.invalidate(); }
  handleInput(data: string): void {
    if (data === "\r" || data === " ") this.toggle();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // TuiAltScreen synthesizes `click` only for a press target it captured first.
    // Capture primary-button presses without focusing or repainting; release then
    // produces one click which follows the same nested child coordinates.
    if (event.type === "press" && event.button === "left") {
      return { handled: true, render: false };
    }
    if (event.y === 0 && event.type === "click") {
      selectedTurnGroup = turnGroups.indexOf(this);
      turnGroups.forEach((group, index) => group.setSelected(index === selectedTurnGroup));
      this.toggle();
      return { handled: true, render: true };
    }
    if (this.expanded && event.type === "click") {
      let offset = 0;
      for (const child of this.children) {
        const height = child.render(event.width).length;
        if (event.y >= offset && event.y < offset + height) {
          const result = child.handleMouse?.({ ...event, y: event.y - offset, height });
          if (result) return result;
        }
        offset += height;
      }
    }
    return undefined;
  }
  toggle(): void {
    this.expanded = !this.expanded;
    this.refreshHeader();
  }
  setSelected(selected: boolean): void { this.selected = selected; this.refreshHeader(); }
  private refreshHeader(): void { this.header.setText(`${this.selected ? "●" : " "} ${this.expanded ? "⌄" : "›"} ${this.label} (Ctrl+O)`); }
}

class FoldableText implements Component {
  private expanded = false;
  private readonly label: Text;
  private readonly content: Text;
  private startedAt: number | undefined;
  private finishedAt: number | undefined;
  constructor(content: Text, label: string) {
    this.content = content;
    this.label = new Text(`› ${label}`, 1, 0);
    latestReasoningFold = this;
    registerFoldItem({ toggle: () => this.toggle(), select: (selected) => this.label.setText(`${selected ? "● " : " "}${this.expanded ? "⌄" : "›"} ${label}`) });
  }
  render(width: number): string[] { return this.expanded ? [...this.label.render(width), ...this.content.render(width)] : this.label.render(width); }
  invalidate(): void { this.label.invalidate(); this.content.invalidate(); }
  handleInput(data: string): void { if (data === "\r" || data === " ") this.toggle(); }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "press" && event.button === "left" && event.y === 0) return { handled: true, render: false };
    if (event.type === "click" && event.button === "left" && event.y === 0) { this.toggle(); return { handled: true, render: true }; }
    return undefined;
  }
  update(text: string): void {
    if (text && this.startedAt === undefined) this.startedAt = performance.now();
    this.refreshLabel();
  }
  private refreshLabel(): void {
    const duration = this.startedAt === undefined ? "" : ` · ${(((this.finishedAt ?? performance.now()) - this.startedAt) / 1000).toFixed(1)}s`;
    this.label.setText(`${this.expanded ? "⌄" : "›"} Thinking${duration}`);
  }
  finish(): void {
    if (this.startedAt === undefined || this.finishedAt !== undefined) return;
    this.finishedAt = performance.now();
    this.update("finished");
  }
  toggle(): void { this.expanded = !this.expanded; this.refreshLabel(); }
}

/** 助手消息：推理区 + 工具调用行 + 流式答案（推理/工具为空时零行渲染）。 */
export class AssistantMessage extends Container {
  private readonly reasoning: Text;
  private readonly reasoningFold: FoldableText;
  private readonly answer: Markdown;
  private readonly toolCalls = new Map<string, ToolCallView>();
  private reasoningMounted = false;

  constructor() {
    super();
    this.reasoning = new Text("", 1, 0);
    this.reasoningFold = new FoldableText(this.reasoning, "思考过程");
    this.answer = new Markdown("", 1, 0, markdownTheme);
    this.addChild(new SpacedBlock(this.answer)); // 答案始终是最后一个 child；空答案不占间距
  }

  /** 更新推理缓冲；非空时首次挂载推理组件（置于最前）。 */
  setReasoning(text: string): void {
    const has = text.trim().length > 0;
    if (has && !this.reasoningMounted) {
      this.children.splice(0, 0, new SpacedBlock(this.reasoningFold));
      this.reasoningMounted = true;
    }
    this.reasoning.setText(has ? text : "");
    if (has) this.reasoningFold.update(text);
  }

  finishThinking(): void { this.reasoningFold.finish(); }

  /** 流式追加：直接用最新完整文本刷新（Text 按 text+width 缓存，重复 setText 廉价）。 */
  setAnswer(text: string): void {
    this.answer.setText(text);
  }

  handleInput(data: string): void {
    if (data === "\\x1b[Z" && this.reasoningMounted) this.reasoning.setText("");
  }

  /** 与状态机的工具条目同步：新增/更新工具行，移除已消失的。 */
  syncToolCalls(entries: Iterable<ToolCallEntry>): void {
    const seen = new Set<string>();
    for (const entry of entries) {
      seen.add(entry.id);
      let view = this.toolCalls.get(entry.id);
      if (!view) {
        view = new ToolCallView();
        this.toolCalls.set(entry.id, view);
        this.insertBefore(new SpacedBlock(view.component), this.children[this.children.length - 1]!);
      }
      view.update(entry);
    }
    for (const [id, view] of this.toolCalls) {
      if (!seen.has(id)) {
        this.removeChild(view.component);
        this.toolCalls.delete(id);
      }
    }
  }

  /** 把 component 插到 ref 之前（保持答案在末尾）。 */
  private insertBefore(component: Component, ref: Component): void {
    const index = this.children.indexOf(ref);
    if (index === -1) {
      this.addChild(component);
      return;
    }
    this.children.splice(index, 0, component);
  }
}
