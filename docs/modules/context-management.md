# 上下文管理

`packages/coding-agent/src/core/context-management.ts` 导出 `BudgetPolicy`、`FileArtifactStore`、
`CompactingExecutor`。`packages/coding-agent/src/core/budget.ts` 的 `InputBudgetTracker` 记录输入
token 估算；按模型目录中的上下文窗口与配置计算预算。启用压缩时，较大的可检索工具输出可写入
按日 artifacts，再向轨迹返回摘要和路径。

`packages/coding-agent/src/core/agent-session.ts` 在调用模型前检查预算；到达阻塞阈值会以
`context_limit` 暂停并保留任务状态。默认宿主由
`packages/coding-agent/src/cli/cli-host-compose.ts` 接入预算策略和 executor 包装。配置键见
[`docs/di-home.md`](../di-home.md)。
