# 回合停止与取消

agent loop 提供两种不同控制：软停止通过 `interruptRequested` 在模型/工具相位边界检查，完成当前
安全边界后返回已收集轨迹并以 `interrupted` 结束；硬取消通过 `AbortSignal` 取消在途模型流或
工具。实现为 `packages/agent/src/agent-loop.ts` 的 `runAgentLoop`，宿主会话
`packages/coding-agent/src/core/agent-session.ts` 提供 `requestSoftStop()` 与每轮 signal 接口。

当前 RPC `interrupt` 请求和 TUI 运行中首按 Ctrl+C 都触发硬取消；TUI 空闲或正在取消时再按 Ctrl+C
请求关闭。RPC wire 将硬取消结果映射为 `stop_reason: "cancelled"`，软停止的 `interrupted` 事件
不会发到 RPC wire，软停止结果通过 `result.stop_reason: "interrupted"` 表示。终端 TUI 的按键处理
在 `tui/src/interactive.ts`，本地 runner 的 `interrupt()` 在
`packages/coding-agent/src/adapters/tui-runner.ts`，RPC 取消在
`packages/coding-agent/src/modes/rpc-mode.ts`。
