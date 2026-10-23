# 上下文预算与压缩

上下文管理在 `packages/coding-agent/src/core/budget.ts`、
`packages/coding-agent/src/core/context-management.ts` 和
`packages/coding-agent/src/core/agent-session.ts` 中实现。`BudgetPolicy` 根据模型上下文窗口与
配置比例计算输入预算；`InputBudgetTracker` 累计消息、工具说明和输出的估算 token。超出预算时，
会话先尝试压缩历史；过大的工具输出可由 `CompactingExecutor` 保存为 artifact，并以引用替代
原始内容，避免把整段输出带入后续请求。

压缩会保留最近对话和必要的工具结果，同时在 checkpoint 中保存当前历史快照，因此恢复会话后
沿用压缩后的上下文。启用开关、预算比例和 artifact 行为以当前配置及对应实现为准；实现细节见
[`modules/context-management.md`](modules/context-management.md)，会话持久化格式见
[`modules/sessions.md`](modules/sessions.md)。

关键实现：`BudgetPolicy`、`FileArtifactStore` 与 `CompactingExecutor`
（`packages/coding-agent/src/core/context-management.ts`）、`InputBudgetTracker`
（`packages/coding-agent/src/core/budget.ts`）、
`AgentSession`（`packages/coding-agent/src/core/agent-session.ts`）。
