/**
 * 终端模式检测：区分「经典 conhost（cmd 窗口）」与「现代终端」。
 *
 * 背景：TuiAltScreen 靠 SGR 鼠标上报（?1000h/?1003h/?1006h）把滚轮事件交给应用，
 * 但经典 conhost 不把鼠标/滚轮转成 SGR 序列送给 Node 进程（libuv 在 conhost 只转发
 * 键盘记录）——pi 用同一套方案在 cmd 里也滚不动即是证明。因此 cmd 下唯一能让用户
 * 用滚轮看历史的方式是退回主缓冲渲染（TuiMainScreen），让 conhost 自己的 scrollback
 * 累积输出、滚轮由控制台原生滚动。
 *
 * 特征变量（取任一存在即为现代终端）：Windows Terminal 设 WT_SESSION；VS Code /
 * mintty / kitty 等设 TERM_PROGRAM；ConEmu 设 ConEmuANSI。经典 cmd 三者皆无。
 */

/** 是否为经典 conhost（cmd 窗口）：win32 且无现代终端特征变量。 */
export function isClassicConhost(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== "win32") {
    return false;
  }
  return !env.WT_SESSION && !env.TERM_PROGRAM && !env.ConEmuANSI;
}