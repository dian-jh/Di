/**
 * 浅灰横向框线：用户消息的条形框（上/下边）与对话框分隔线，与输入框 Editor 边框同色。
 * 宽度按渲染时 viewport 计算，窄终端 / 改大小不越界。
 * 颜色可配置（默认浅灰 #a0a0a0——比纯白淡，见 parseColor 只认数字/hex/oklch/okhsl）。
 */

import { getTerminalColorMode, parseColor, styleText, type Component } from "@earendil-works/pi-tui";

const colorMode = getTerminalColorMode();

export class Rule implements Component {
  private readonly color: string;

  constructor(color = "#a0a0a0") {
    this.color = color;
  }

  render(width: number): string[] {
    return [styleText("─".repeat(Math.max(0, width)), { fg: parseColor(this.color) }, colorMode)];
  }

  invalidate(): void {
    /* 无缓存状态，无需失效 */
  }
}