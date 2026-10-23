/**
 * 独立启动时的 TUI 入口：决策后端启动器 → `RpcClientPort`（spawn `--mode rpc`）
 * → `runInteractive(port)`（terminal / state / view / 输入键盘 / stop 生命周期）。
 *
 * `runInteractive` 处理连接失败、后端退出和优雅关闭；本文件负责后端启动器决策与入口退出。
 * 生产 CLI 的同进程 local runner 由 coding-agent 的 adapter 走同一 `runInteractive`。
 */

import { RpcClientPort } from "./runner/rpc-port.ts";
import { runInteractive } from "./interactive.ts";
import { buildBackendLauncher } from "./rpc/backend-launcher.ts";

async function main(): Promise<number> {
  const decision = buildBackendLauncher(process.env);
  if (decision.kind === "unavailable") {
    console.error(
      "未找到 di 后端：请构建或安装 TypeScript 后端（@di/coding-agent），或设置环境变量 DI_BIN 指定 RPC 启动程序。",
    );
    return 1;
  }
  const { launcher } = decision;

  try {
    await runInteractive(new RpcClientPort({ launcher }), { title: "di — TUI" });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
