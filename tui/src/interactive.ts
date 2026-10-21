/**
 * runInteractive(port)：把给定 {@link RunnerPort} 接入现有 TUI 组件树并驱动交互。
 *
 * 从 `tui/src/main.ts` 提取的 TUI shell 边界（architecture.md §生产入口）：
 * 创建 terminal / TurnStateMachine / ChatView / 输入键盘 / stop 生命周期全部在此，
 * 调用方只提供已构造的 port。`tui/src/app/` 的组件（state.ts / chat-view.ts /
 * message.ts / tool-call.ts / commands.ts / terminal-mode.ts）零改动——本文件与
 * RPC 路径共用同一事件/状态机。
 *
 * 接线顺序（architecture.md §RunnerPort 生命周期）：
 *   1. 注册全部 port handlers（返回的 unsubscribe 保存）；
 *   2. await port.connect()（只在其 onReady(meta) 已执行一次后 resolve；失败抛错，
 *      不进入可输入状态）；
 *   3. 构建 terminal/view/输入回调；ready 元数据已就位，启动即同步一次视图。
 * 退出 finally：停键盘 → await port.stop()（幂等）→ 停视图/terminal → 注销 handlers
 * 与进程信号监听。connect 未成功时仍注销 handlers。
 *
 * 返回的 promise 在用户优雅退出时 resolve（不再用 process.exit 抢占进程；
 * 入口 main.ts 在 resolve 后自行 exit(code)）。
 */

import {
  getTerminalColorMode,
  matchesKey,
  parseColor,
  ProcessTerminal,
  styleText,
  TuiAltScreen,
} from "@earendil-works/pi-tui";
import { ChatView } from "./app/chat-view.ts";
import { cycleTurnGroup, toggleLatestReasoning, toggleLatestTurnGroup } from "./app/message.ts";
import { toggleLatestToolCall } from "./app/tool-call.ts";
import { selectFoldItem, toggleSelectedFoldItem } from "./app/fold-navigation.ts";
import { normalizeSlash } from "./app/commands.ts";
import { startInteractiveScreen, terminalScreenMode } from "./app/terminal-mode.ts";
import { TurnStateMachine } from "./app/state.ts";
import { CommandError } from "./rpc/client.ts";
import type { RunnerCommandResult, RunnerPort } from "./runner/port.ts";

/** runInteractive 的显示选项。 */
export interface InteractiveOptions {
  /** 终端窗口标题（默认 "di — TUI"）。 */
  readonly title?: string;
}

/** 判断命令错误是否携带 turn_not_supported 载荷（RPC CommandError 或同进程 adapter 等价错误）。 */
function isTurnCommandError(err: unknown): err is { code: "turn_not_supported"; turnMessage: string } {
  if (err instanceof CommandError) {
    return err.code === "turn_not_supported" && typeof err.turnMessage === "string";
  }
  if (typeof err === "object" && err !== null) {
    const candidate = err as { code?: unknown; turnMessage?: unknown };
    return candidate.code === "turn_not_supported" && typeof candidate.turnMessage === "string";
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 驱动 TUI 直到用户优雅退出（/exit、Ctrl+C idle、SIGINT/SIGTERM、后端 exit 命令）。
 * @param port 已构造的 RunnerPort（RpcClientPort 或 LocalAgentRunnerAdapter）。
 */
export async function runInteractive(port: RunnerPort, options?: InteractiveOptions): Promise<void> {
  const state = new TurnStateMachine();
  let view: ChatView | null = null;
  let stopping = false;

  // 1. 先注册 handlers（connect 前）；port 在 connect 前缓存，ready 只发一次。
  const unsubscribe = port.subscribe({
    onReady: (meta) => {
      state.setMeta(meta);
    },
    onEvent: (event) => {
      state.applyEvent(event);
      view?.sync(state);
    },
    onResult: (result) => {
      state.finishTurn(result);
      view?.sync(state);
    },
    onError: (message) => {
      state.abort(message);
      view?.sync(state);
    },
    onStderr: (chunk) => process.stderr.write(chunk),
    onExit: (code, signal) => {
      if (!stopping) {
        state.abort(`后端进程退出（exit=${code ?? "?"}${signal ? `, signal=${signal}` : ""}）`);
        view?.sync(state);
      }
    },
    onMalformed: (line, err) => {
      process.stderr.write(`[rpc] 忽略无法解析的行（${err.message}）\n`);
    },
  });

  // 2. 连接握手；失败走调用方的错误/退出路径（不进入可输入状态）。
  try {
    await port.connect();
  } catch (err) {
    unsubscribe();
    throw err;
  }

  const terminal = new ProcessTerminal();
  // 一律使用可交互的全屏视口，避免 Windows cmd 环境退化为不支持鼠标折叠的主屏模式。
  // 应用内完整 transcript 仍由 ScrollView 保留，可用滚轮 / PgUp / PgDn 查看历史。
  const screenMode = terminalScreenMode();
  if (screenMode !== "interactive") throw new Error(`Unsupported terminal mode: ${screenMode}`);
  const tui = new TuiAltScreen(terminal, undefined, undefined, {
    mouse: true,
    wheelScrollLines: 3,
    scrollToEndIndicator: () =>
      styleText(" ↓ 最新消息 ", { fg: parseColor("#a0a0a0") }, getTerminalColorMode()),
  });

  view = new ChatView(tui, (text) => {
    if (!state.isIdle) {
      state.statusText = "上回合还在运行，请等它结束（Ctrl+C 可中断）";
      view?.sync(state);
      return;
    }
    if (text.startsWith("/")) {
      if (text.trim() === "/usage") {
        state.startCommand(text);
        state.finishCommand(state.usageSummary());
        view?.sync(state);
        return;
      }
      // 斜杠命令：交给后端注册表执行（内置 + 用户命令在宿主侧，TUI 只做前缀路由）。
      state.startCommand(text);
      void runCommand(text);
      return;
    }
    state.startTurn(text);
    view?.sync(state);
    port
      .prompt(text)
      .catch((err: unknown) => {
        state.abort(errorMessage(err));
        view?.sync(state);
      });
  });

  // Ctrl+C：运行中首按 → interrupt（取消当前回合）；cancelling/idle → shutdown（退出）。
  const unsubscribeInput = tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+o")) { toggleLatestTurnGroup(); tui.requestRender(); return { consume: true }; }
    if (matchesKey(data, "ctrl+up")) { cycleTurnGroup(-1); tui.requestRender(); return { consume: true }; }
    if (matchesKey(data, "ctrl+down")) { cycleTurnGroup(1); tui.requestRender(); return { consume: true }; }
    if (matchesKey(data, "alt+up")) { selectFoldItem(-1); tui.requestRender(); return { consume: true }; }
    if (matchesKey(data, "alt+down")) { selectFoldItem(1); tui.requestRender(); return { consume: true }; }
    if (matchesKey(data, "ctrl+enter")) { toggleSelectedFoldItem(); tui.requestRender(); return { consume: true }; }
    if (matchesKey(data, "ctrl+r")) { toggleLatestReasoning(); tui.requestRender(); return { consume: true }; }
    if (matchesKey(data, "ctrl+t")) { toggleLatestToolCall(); tui.requestRender(); return { consume: true }; }
    if (!matchesKey(data, "ctrl+c")) return undefined;
    if (state.state === "running") {
      state.requestCancel();
      port.interrupt();
      view?.sync(state);
    } else {
      void shutdown();
    }
    return { consume: true };
  });

  tui.terminal.setTitle(options?.title ?? "di — TUI");
  startInteractiveScreen(tui);
  // 启动即同步一次视图：ready 握手已有元数据，模型徽标 / 状态行无需等第一次对话。
  view.sync(state);
  view.focusInput();

  // ready 握手携带 skills/models 元数据已完成，这里再拉一次命令注册表，装配命令补全
  //（失败只降级为无补全，不阻塞聊天）。
  void loadAutocomplete();

  /** 拉取命令注册表并装配命令补全（/ 弹菜单、/m 模糊、/model /skill 参数补全）。 */
  async function loadAutocomplete(): Promise<void> {
    try {
      const commands = await port.listCommands();
      view?.setAutocomplete(commands, state.skills, state.models);
    } catch {
      /* 补全数据不可用仅降级：无命令面板，其余功能照常 */
    }
  }

  /** 运行一条斜杠命令（同步应答，不流式）：成功显示输出行；exit=true 则优雅退出。 */
  async function runCommand(text: string): Promise<void> {
    const { name, args } = normalizeSlash(text);
    try {
      const result: RunnerCommandResult = await port.runCommand(name, args);
      if (result.exit) {
        await shutdown();
        return;
      }
      // /model 切换后应答携带新模型/强度快照，状态栏据此更新（不依赖解析中文提示）。
      if (result.model !== undefined) {
        state.applyModel(result.model, result.effort === undefined ? state.effort : result.effort);
      }
      if (result.models !== undefined) {
        state.models = result.models;
        await loadAutocomplete();
      }
      state.finishCommand(result.lines.join("\n"));
    } catch (err: unknown) {
      if (isTurnCommandError(err)) {
        // 回合型命令（/skill <名> <参数>、用户命令）：协议规定 TUI 改用自身 prompt 机制跑回合。
        state.commandInput = "";   // 不把它们当普通命令回显，避免后续命令 echo 出陈旧输入
        state.startTurn(err.turnMessage);
        view?.sync(state);
        port
          .prompt(err.turnMessage)
          .catch((e: unknown) => {
            state.abort(errorMessage(e));
            view?.sync(state);
          });
        return;
      }
      state.abort(errorMessage(err));
    }
    view?.sync(state);
  }

  /** 优雅退出：停输入 → stop 后端 → 停 TUI → resolve。 */
  let resolveExit: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    unsubscribeInput();
    try {
      await port.stop();
    } catch {
      /* 后端清理失败不阻塞退出 */
    }
    tui.stop();
    resolveExit();
  }

  // 进程级信号（终端 raw 模式下的 Ctrl+C 走输入监听器，不触发这里）。
  const onSigint = () => void shutdown();
  const onSigterm = () => void shutdown();
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    await exited;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    unsubscribe();
  }
}
