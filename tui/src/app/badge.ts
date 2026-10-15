/**
 * 带徽标的输入框包装：把模型徽标（模型 · 强度）渲染在输入框下方独立一行、右对齐。
 *
 * 早期版本把徽标合成进 Editor 底部边框线，模型名与对话框同处一行视觉冲突；
 * 改为追加独立行后输入框自然上移一行，徽标独占 dock 最底部。
 *
 * pi-tui 的鼠标事件按屏幕位置沿组件树分发（见 tui.js dispatchMouseEvent / Container.handleMouse），
 * 因此包装组件必须把 handleMouse 委托给内层 Editor；键盘输入直接走聚焦的内层 Editor
 * （ChatView.focusInput 聚焦的是 editor 本身），绕开包装，无需转发。
 * 自动补全菜单展开时跳过徽标行（菜单收起后恢复，避免徽标悬在菜单项下方）。
 */

import {
  getTerminalColorMode,
  parseColor,
  styleText,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

const colorMode = getTerminalColorMode();

/** 徽标文字颜色（与输入框边框同款浅灰）。 */
const badgeColor = parseColor("#a0a0a0");

/** BadgedEditor 需要的内层组件最小接口（Editor 结构性满足；测试可注入假目标）。 */
export interface BadgedTarget {
  render(width: number): string[];
  invalidate(): void;
  isShowingAutocomplete(): boolean;
  handleInput?(data: string): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

export class BadgedEditor implements Component {
  private readonly target: BadgedTarget;
  private badgeText = "";

  constructor(target: BadgedTarget) {
    this.target = target;
  }

  /** 更新右下角徽标文本（空串 = 不显示）。 */
  setBadge(text: string): void {
    this.badgeText = text;
  }

  render(width: number): string[] {
    const lines = this.target.render(width);
    const badge = this.badgeText;
    if (!badge || lines.length === 0 || this.target.isShowingAutocomplete()) {
      return lines;
    }
    // 徽标独占一行：右对齐、与输入框（含其边框）分行；窄终端放不下则整行放弃。
    const badgeWidth = visibleWidth(badge);
    if (badgeWidth + 2 > width) {
      return lines;
    }
    const out = [...lines];
    out.push(" ".repeat(Math.max(0, width - badgeWidth)) + styleText(badge, { fg: badgeColor }, colorMode));
    return out;
  }

  invalidate(): void {
    this.target.invalidate();
  }

  handleInput(data: string): void {
    this.target.handleInput?.(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.target.handleMouse?.(event);
  }
}