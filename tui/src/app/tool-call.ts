/**
 * 工具调用组件：单行标题（名称 + 截断参数）+ 完成后的观察结果。
 * M1 不折叠；M2 再做折叠 / 展开。
 */

import { Text } from "@earendil-works/pi-tui";
import type { ToolCallEntry } from "./state.ts";

const STATUS_MARK: Record<ToolCallEntry["status"], string> = {
  pending: "⏳",
  running: "⏳",
  completed: "✓",
  failed: "✗",
};

/** 截断到可见宽度上限（不破坏 ANSI 序列——此处为纯文本）。 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 工具调用视图：包裹一个 Text，供容器动态增删。 */
export class ToolCallView {
  readonly component: Text;

  constructor() {
    this.component = new Text("", 1, 0);
  }

  /** 根据条目状态刷新显示。 */
  update(entry: ToolCallEntry): void {
    const args = entry.arguments.trim() ? ` ${truncate(entry.arguments.trim(), 80)}` : "";
    const title = `${STATUS_MARK[entry.status]} ${entry.name}${args}`;
    if (entry.status === "completed" || entry.status === "failed") {
      const observation = truncate((entry.observation ?? "").trim(), 120);
      if (observation) {
        const mark = entry.status === "failed" ? "✗" : "↳";
        this.component.setText(`${title}\n  ${mark} ${observation}`);
        return;
      }
    }
    this.component.setText(title);
  }
}
