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

## 文本选择与复制

按住鼠标左键拖动可选择消息文字，松开后自动复制；双击选择词，三击选择整行。
复制通过终端的 OSC 52 剪贴板协议完成，需要终端允许应用访问剪贴板。
Thinking 和工具调用标题仍支持单击展开或收起；拖选标题或已展开的正文不会触发折叠。

`tui/src/app/message.ts` 的 `TurnGroup.handleMouse`、`FoldableText.handleMouse` 和
`tui/src/app/tool-call.ts` 的 `ToolCallComponent.handleMouse` 只处理完成的点击，
将按下和拖动留给 `TuiAltScreen` 的选择逻辑。回归测试位于
`tui/test/mouse-interaction.test.ts`。
