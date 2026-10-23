# Agent loop

`packages/agent/src/agent-loop.ts` 导出 `runAgentLoop`，驱动单次循环：请求模型流、累计 assistant
轨迹；模型返回工具调用时，校验并依次调用注入的 `ToolExecutor`，再把观察结果加入下一次模型
请求。loop 只依赖 `packages/agent/src/types.ts` 中的请求、结果、事件和 checkpoint 契约，不拥有
文件系统、配置或 CLI。

`AgentDependencies` 注入 `ChatModel`、`ToolExecutor`、可选 validator、事件 sink 与 checkpoint。
软停止通过 `interruptRequested` 在模型/工具相位边界检查，返回部分轨迹与 `interrupted`；
`AbortSignal` 负责硬取消，可中止在途操作。上下文预算阻止继续请求时返回 `context_limit`。
跨回合历史和持久化归 `packages/coding-agent/src/core/agent-session.ts` 的 `AgentSession` 管理。

关键符号：`runAgentLoop`、`LoopError`（`packages/agent/src/agent-loop.ts`）；`AgentRequest`、
`AgentDependencies`、`AgentEvent`、`AgentResult`（`packages/agent/src/types.ts`）。会话数据流见
[`docs/architecture.md`](../architecture.md)。
