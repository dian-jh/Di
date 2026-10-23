# ChatGPT provider 与认证

Responses API 适配器是 `packages/ai/src/providers/chatgpt/adapter.ts` 的 `ChatGptAdapter`；
`packages/ai/src/providers/chatgpt/wire.ts` 定义请求/响应结构，
`packages/ai/src/providers/chatgpt/translator.ts` 处理内部消息和 provider 载荷的转换。

Node 宿主 OAuth 实现在 `packages/coding-agent/src/core/auth/chatgpt-auth.ts` 的 `ChatGptAuth`；
凭据模型与文件读写在 `packages/coding-agent/src/core/auth/credential-store.ts` 的
`CredentialStore`。更新凭据时持有 `packages/coding-agent/src/core/auth/lock-provider.ts` 的
`NativeOsLockProvider` 原生跨进程锁，锁不可用时不会无锁写入。CLI 登录、
状态、模型列表和退出命令由 `packages/coding-agent/src/cli/auth-command.ts` 接线。

关键符号：`ChatGptAdapter`、`ChatGptAuth`、`CredentialStore`、`NativeOsLockProvider`；源码路径见
以上引用。认证与会话文件位置见 [`docs/di-home.md`](../di-home.md)。
