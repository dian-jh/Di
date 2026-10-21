/**
 * TUI 入口（旧 RPC launcher）：决策后端启动器 → `RpcClientPort`（spawn `--mode rpc`）
 * → `runInteractive(port)`（terminal / state / view / 输入键盘 / stop 生命周期）。
 *
 * 外部 RPC 路径保持原行为：`runInteractive` 的 connect 失败 / 后端退出 / 优雅关闭
 * 语义与旧 main.ts 的 RpcClient 直连一致；本文件只留下后端启动器决策与入口退出。
 * 生产 CLI 的同进程 local runner 由 coding-agent 的 adapter 走同一 `runInteractive`。
 */

import { RpcClientPort } from "./runner/rpc-port.ts";
import { runInteractive } from "./interactive.ts";
import { buildBackendLauncher } from "./rpc/backend-launcher.ts";

async function main(): Promise<number> {
  const decision = buildBackendLauncher(process.env);
  if (decision.kind === "unavailable") {
    console.error(
      "未找到 di 后端：请设置环境变量 DI_BIN（显式指定二进制），或先构建 TS 后端（packages/coding-agent），或确保 `di` 在 PATH / ~/.di/bin 下。",
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
