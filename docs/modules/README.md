# 核心模块索引

以下源码路径相对仓库根目录，当前实现均为 TypeScript。

| 模块 | 文档 | 源码入口 | 说明 |
|---|---|---|---|
| Agent loop | [`agent-loop.md`](agent-loop.md) | `packages/agent/src/` | 单回合模型与工具调度 |
| Context management | [`context-management.md`](context-management.md) | `packages/coding-agent/src/core/context-management.ts`; `packages/coding-agent/src/core/budget.ts` | 上下文预算与工具输出压缩 |
| AI / 模型 | [`llm.md`](llm.md) | `packages/ai/src/` | provider、流、重试、计量 |
| 事件 | [`events.md`](events.md) | `packages/agent/src/types.ts`; `packages/coding-agent/src/core/events/` | Agent 事件与宿主事件总线 |
| 工具 | [`tools.md`](tools.md) | `packages/coding-agent/src/core/tools/` | 内置工具与进程执行 |
| Skills | [`skills.md`](skills.md) | `packages/coding-agent/src/core/skills/` | 发现、匹配和按需加载 |
| Sessions | [`sessions.md`](sessions.md) | `packages/coding-agent/src/core/sessions/`; `packages/coding-agent/src/core/agent-session.ts` | JSONL、恢复与跨回合状态 |
| Logging | [`logging.md`](logging.md) | `packages/coding-agent/src/core/logging/` | 运行日志与进程诊断 |
| DeepSeek | [`deepseek.md`](deepseek.md) | `packages/ai/src/providers/deepseek/` | DeepSeek Chat 适配器 |
| ChatGPT | [`chatgpt.md`](chatgpt.md) | `packages/ai/src/providers/chatgpt/`; `packages/coding-agent/src/core/auth/` | Responses API 与 OAuth |

配置与 `~/.di` 规范见 [`docs/di-home.md`](../di-home.md)，跨包依赖见
[`docs/architecture.md`](../architecture.md)。
