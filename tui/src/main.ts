/**
 * TUI 入口：解析 di 二进制 → spawn `--mode rpc` → 装配视图 → 事件循环。
 *
 * 流程：
 * 1. 解析 di 可执行文件（DI_BIN → PATH → ~/.di/bin/di.exe）。
 * 2. 创建 RpcClient 并等待 `ready` 握手（失败则报错退出）。
 * 3. 构建 TuiMainScreen（常规主屏）+ ChatView。
 * 4. 客户端事件 → 状态机（state）→ 视图（view.sync）。
 * 5. 输入：Enter 提交 prompt；Ctrl+C 首按 interrupt、次按 shutdown 退出。
 */

import { matchesKey, ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { ChatView } from "./app/chat-view.ts";
import { TurnStateMachine } from "./app/state.ts";
import { RpcClient, resolveDiBin } from "./rpc/client.ts";

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
  const tui = new TuiMainScreen(terminal);

  view = new ChatView(tui, (text) => {
    if (!state.isIdle) {
      state.statusText = "上回合还在运行，请等它结束（Ctrl+C 可中断）";
      view?.sync(state);
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
  tui.start();
  view.focusInput();

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
