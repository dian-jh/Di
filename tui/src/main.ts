/**
 * TUI 入口：解析 di 二进制 → spawn `--mode rpc` → 装配视图 → 事件循环。
 *
 * 流程：
 * 1. 解析 di 可执行文件（DI_BIN → PATH → ~/.di/bin/di.exe）。
 * 2. 创建 RpcClient 并等待 `ready` 握手（失败则报错退出）。
 * 3. 构建 TuiAltScreen（全屏视口）+ ChatView —— 输入框固定 dock 在终端底部（见 chat-layout.ts）。
 * 4. 客户端事件 → 状态机（state）→ 视图（view.sync）。
 * 5. 输入：Enter 提交 prompt；Ctrl+C 首按 interrupt、次按 shutdown 退出。
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
import { CommandError, RpcClient, resolveDiBin } from "./rpc/client.ts";

async function main(): Promise<number> {
  const bin = resolveDiBin();
  if (!bin) {
    console.error(
      "未找到 di 可执行文件：请设置环境变量 DI_BIN，或确保 `di` 在 PATH / ~/.di/bin 下。",
    );
    return 1;
  }

  const state = new TurnStateMachine();
  let view: ChatView | null = null;
  let stopping = false;

  const client = new RpcClient({
    bin,
    args: ["--mode", "rpc"],
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

  try {
    await client.connect();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
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
      // 斜杠命令：交给后端注册表执行（内置 + 用户命令在 C# 宿主侧，TUI 只做前缀路由）。
      state.startCommand(text);
      void runCommand(text);
      return;
    }
    state.startTurn(text);
    view?.sync(state);
    client
      .prompt(text)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        state.abort(message);
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
      client.interrupt();
      view?.sync(state);
    } else {
      void shutdown();
    }
    return { consume: true };
  });

  tui.terminal.setTitle("di — TUI");
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
      const commands = await client.listCommands();
      view?.setAutocomplete(commands, state.skills, state.models);
    } catch {
      /* 补全数据不可用仅降级：无命令面板，其余功能照常 */
    }
  }

  /** 运行一条斜杠命令（同步应答，不流式）：成功显示输出行；exit=true 则优雅退出。 */
  async function runCommand(text: string): Promise<void> {
    const { name, args } = normalizeSlash(text);
    try {
      const result = await client.runCommand(name, args);
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
      if (err instanceof CommandError && err.code === "turn_not_supported" && err.turnMessage) {
        // 回合型命令（/skill <名> <参数>、用户命令）：协议规定 TUI 改用自身 prompt 机制跑回合。
        state.commandInput = "";   // 不把它们当普通命令回显，避免后续命令 echo 出陈旧输入
        state.startTurn(err.turnMessage);
        view?.sync(state);
        client
          .prompt(err.turnMessage)
          .catch((e: unknown) => {
            state.abort(e instanceof Error ? e.message : String(e));
            view?.sync(state);
          });
        return;
      }
      state.abort(err instanceof Error ? err.message : String(err));
    }
    view?.sync(state);
  }

  /** 优雅退出：shutdown 后端 → 停止 TUI → 退出。 */
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    unsubscribeInput();
    try {
      await client.stop();
    } catch {
      /* 后端清理失败不阻塞退出 */
    }
    tui.stop();
    process.exit(0);
  }

  // 进程级信号（终端 raw 模式下的 Ctrl+C 走输入监听器，不触发这里）。
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  return new Promise<number>(() => {
    /* 保持进程存活，直到 shutdown() 显式退出 */
  });
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
