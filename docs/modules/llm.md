# AI 与模型

`packages/ai/src/types/` 定义统一的消息、内容块、工具、`ChatModel`、请求/响应、token 用量、成本、
finish reason 和 provider 中立错误。`ChatModel.stream` 产出模型事件；
`packages/ai/src/stream-assembler.ts` 将流式增量组装为完整响应，`retry/` 实现有界重试，
`usage.ts` 计算计量，`catalog.ts` 提供静态模型目录。

`packages/ai/src/providers/deepseek/` 和 `providers/chatgpt/` 各自封装 wire DTO、翻译与 HTTP/SSE
适配。coding-agent 的 `packages/coding-agent/src/cli/provider-runtime.ts`
（`createDefaultProviderRuntime`）根据 provider/model 路由建立适配器并加重试包装；
`packages/agent/src/agent-loop.ts` 只依赖注入的 `ChatModel`。
