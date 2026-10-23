# 架构概览

Di 由 TypeScript workspace 组成。依赖从界面和宿主流向核心：`tui` 负责终端交互，
`@di/coding-agent` 负责 Node.js 集成和应用组合，`@di/agent` 实现与 provider 无关的 agent loop，
`@di/ai` 定义模型类型与 provider 适配器。

## 包与边界

- `packages/agent/src/agent-loop.ts` 的 `runAgentLoop` 驱动模型流和工具执行，事件类型位于
  `packages/agent/src/types.ts`。
- `packages/ai/src/types/` 定义模型、消息和流类型；`packages/ai/src/providers/` 实现
  DeepSeek 与 ChatGPT 协议适配。
- `packages/coding-agent/src/cli/main.ts` 启动 CLI；`packages/coding-agent/src/cli/cli-host-compose.ts` 组合配置、provider、
  工具、会话与 `AgentSession`。宿主核心位于 `packages/coding-agent/src/core/`，模式位于
  `packages/coding-agent/src/modes/`。
- `tui/src/interactive.ts` 提供交互 UI；`tui/src/runner/port.ts` 定义 Runner 接口。
  本地 adapter 由 coding-agent 提供；独立 RPC 客户端和 wire 类型位于 `tui/src/rpc/`。

## 一次交互

CLI 解析参数并构造宿主，模式选择决定进入交互、文本单发、JSON 或 RPC 路径。`AgentSession`
维护跨回合历史并调用 `runAgentLoop`；loop 向 `ChatModel` 请求流式响应，必要时通过工具执行器
运行工具，再发出完成或停止事件。`SessionStore` 持久化审计记录与恢复 checkpoint。交互模式把
runner 事件交给 TUI 渲染；RPC 模式将事件编码为 NDJSON。

源码入口：`packages/coding-agent/src/cli/cli-host-compose.ts`（`createCliHost`）、
`packages/coding-agent/src/core/agent-session.ts`（`AgentSession`）、
`packages/agent/src/agent-loop.ts`（`runAgentLoop`）、`packages/ai/src/stream-assembler.ts`
（流装配）及 `tui/src/interactive.ts`（`runInteractive`）。模块映射见
[`docs/modules/README.md`](modules/README.md)。
