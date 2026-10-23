# DeepSeek provider

`packages/ai/src/providers/deepseek/adapter.ts` 的 `DeepSeekAdapter` 实现共享 `ChatModel` 接口；
`translator.ts` 转换消息、工具调用和响应，`wire.ts` 保存 provider 专用结构。

`packages/coding-agent/src/cli/provider-runtime.ts` 的 `createDefaultProviderRuntime` 从配置读取
API key、base URL、超时、流空闲超时、system proxy 和 strict tools 选项，并将 adapter 包在重试
模型中。API key 可由 `DeepSeek.ApiKey` 或 `DEEPSEEK_API_KEY` 提供。
