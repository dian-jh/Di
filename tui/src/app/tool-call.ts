/**
 * 工具调用组件：单行标题（名称 + 截断参数）+ 完成后的观察结果。
 * M1 不折叠；M2 再做折叠 / 展开。
 */

import { Text, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ToolCallEntry } from "./state.ts";
import { registerFoldItem } from "./fold-navigation.ts";
import { mutedText } from "./colors.ts";

const STATUS_MARK: Record<ToolCallEntry["status"], string> = {
  pending: "⏳",
  running: "⏳",
  completed: "✓",
  failed: "✗",
};
let latestToolCall: ToolCallView | undefined;
export function toggleLatestToolCall(): void { latestToolCall?.toggle(); }

/** 截断到可见宽度上限（不破坏 ANSI 序列——此处为纯文本）。 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 工具调用视图：包裹一个 Text，供容器动态增删。 */
class ToolCallComponent implements Component {
  private readonly view: ToolCallView;
  constructor(view: ToolCallView) { this.view = view; }
  render(width: number): string[] { return this.view.render(width); }
  invalidate(): void { this.view.invalidate(); }
  handleInput(data: string): void { if (data === "\r" || data === " ") this.view.toggle(); }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "click" && event.button === "left" && event.y === 0) { this.view.toggle(); return { handled: true, render: true }; }
    return undefined;
  }
}

export class ToolCallView implements Component {
  readonly component: Component;
  private readonly text: Text;
  private expanded = false;
  private startedAt: number | undefined;
  private durationMs: number | undefined;
  private previousStatus: ToolCallEntry["status"] | undefined;

  constructor() {
    latestToolCall = this;
    this.text = new Text("", 1, 0, mutedText);
    this.component = new ToolCallComponent(this);
    registerFoldItem({ toggle: () => this.toggle(), select: (selected) => { if (this.entry) this.refresh(selected); } });
  }

  /** 根据条目状态刷新显示。 */
  update(entry: ToolCallEntry): void {
    if ((entry.status === "running" || entry.status === "pending") && this.previousStatus !== "running") this.startedAt = performance.now();
    if ((entry.status === "completed" || entry.status === "failed") && this.startedAt !== undefined && this.durationMs === undefined) this.durationMs = performance.now() - this.startedAt;
    this.previousStatus = entry.status;
    this.entry = entry;
    this.refresh();
  }

  private entry?: ToolCallEntry;
  render(width: number): string[] { return this.text.render(width); }
  invalidate(): void { this.text.invalidate(); }
  toggle(): void { this.expanded = !this.expanded; this.refresh(); }

  private refresh(selected = false): void {
    const entry = this.entry;
    if (!entry) return;
    const duration = this.durationMs === undefined ? (entry.status === "running" && this.startedAt !== undefined ? ` ${((performance.now() - this.startedAt) / 1000).toFixed(1)}s` : "") : ` ${(this.durationMs / 1000).toFixed(1)}s`;
    const args = entry.arguments.trim() ? `\n  args ${truncate(entry.arguments.trim(), 240)}` : "";
    const title = `${STATUS_MARK[entry.status]} ${entry.name}${duration}`;
    if (entry.status === "completed" || entry.status === "failed") {
      const observation = truncate((entry.observation ?? "").trim(), 120);
      if (observation) {
        const mark = entry.status === "failed" ? "✗" : "↳";
        this.text.setText(this.expanded ? `${selected ? "● " : ""}${title}${args}\n  ${mark} ${observation}` : `${selected ? "● " : ""}${title}  [Alt+↑/↓ Ctrl+Enter/click]`);
        return;
      }
    }
    this.text.setText(this.expanded ? `${selected ? "● " : ""}${title}${args}\n  [running]` : `${selected ? "● " : ""}${title}  [Alt+↑/↓ Ctrl+Enter/click]`);
  }

}
