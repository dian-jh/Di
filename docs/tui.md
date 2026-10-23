# 终端界面

TUI 实现在仓库根 `tui/`，以 `RunnerPort` 接收 agent 事件并通过 `runInteractive` 驱动终端组件。
CLI 的本地 runner adapter 位于 `packages/coding-agent/src/adapters/tui-runner.ts`；独立 RPC
客户端通过相同端口接入，协议见 [`docs/tui-rpc.md`](tui-rpc.md)。

关键入口：`tui/src/interactive.ts`（`runInteractive`）、`tui/src/runner/port.ts`
（`RunnerPort`）、`tui/src/rpc/backend-launcher.ts`（`buildBackendLauncher`）。后端启动优先
使用显式 `DI_BIN`；否则解析 workspace 编译入口或安装在同级 `node_modules` 的
`@di/coding-agent` 入口，并以当前 Node 可执行文件启动。

界面状态和渲染位于 `tui/src/app/`。通用运行模式、会话与事件数据流见
[`docs/architecture.md`](architecture.md)。
