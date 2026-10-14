/**
 * 带右下角徽标的输入框包装：把模型徽标（模型 · 强度）合成到 Editor 底部边框线的右下角。
 *
 * pi-tui 的鼠标事件按屏幕位置沿组件树分发（见 tui.js dispatchMouseEvent / Container.handleMouse），
 * 因此包装组件必须把 handleMouse 委托给内层 Editor；键盘输入直接走聚焦的内层 Editor
 * （ChatView.focusInput 聚焦的是 editor 本身），绕开包装，无需转发。
 * 自动补全菜单展开时底部行是菜单项，此时跳过合成（菜单收起后徽标恢复）。
 */

import {
  compositeTuiLine,
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
    const last = lines[lines.length - 1] ?? "";
    const visible = visibleWidth(last);
    const badgeWidth = visibleWidth(badge);
    if (badgeWidth + 2 > visible) {
      // 终端太窄：放弃合成，避免徽标挤占内容。
      return lines;
    }
    const composited = compositeTuiLine(
      last,
      styleText(badge, { fg: badgeColor }, colorMode),
      visible - badgeWidth,
      badgeWidth,
      visible,
    );
    const out = [...lines];
    out[out.length - 1] = composited;
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