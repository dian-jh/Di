# ChatGPT 与模型切换

ChatGPT 通过官方开源客户端 OAuth 流程注册和授权，使用 access token 直接调用
https://api.openai.com/v1/responses，无需 API Key 或 client secret。

## 登录

```powershell
di auth chatgpt login
di auth chatgpt status
di auth chatgpt models
di --model chatgpt/<返回的slug> "检查项目"
```

一份 ChatGPT 凭据对应当前连接。普通 login 复用 issued client ID；更换账户或
workspace 使用 login --new，重新申请 plan 权限使用 login --consent。
logout 撤销 refresh token 并清空本地令牌，保留 host ID 和 issued client ID。

校验参考本地 pi 的 packages/ai/src/auth/oauth/openai-chatgpt.ts：
检查回调路径、state、code、issued client ID、PKCE、令牌字段和正数 expires_in，
要求 chatgpt.tokens.use.direct scope。ID Token 仅检查存在、保存为授权提示；
不解析个人资料、不声明通过 ID Token 验证用户身份，因此不维护 JWKS/身份账户体系。
scope 或字段不合法时拒绝替换已有连接。回调在 127.0.0.1 随机端口监听，5 分钟超时。

凭据位于 $DI_HOME/auth/chatgpt/credentials.json（默认 ~/.di）。
Windows 使用当前用户目录 ACL；Unix 为目录 0700、文件 0600。`CredentialStore.update` 是唯一写入口，
`NativeOsLockProvider` 用 Windows `LockFileEx` 或 POSIX `flock` 覆盖读取、网络刷新和原子替换，避免跨进程
重复使用轮换令牌。Windows x64 已通过合成双进程竞争与持锁进程强杀释放验证；Linux/macOS 尚未本机验收。

TS CLI 的认证与模型请求通过 `packages/coding-agent/src/cli/windows-system-proxy.ts` 的 `createSystemProxyFetch` 默认读取 Windows 当前用户系统代理；其它平台目前使用直接 fetch。静态代理由 `undici` 转发，PAC/WPAD 由 `resolveWindowsSystemProxy` 通过 Windows PowerShell 调用系统代理解析器，15 秒超时并支持取消；解析失败不会触发直接请求。注入测试 fetch 时不会读取真实代理设置。自动配置的路由/错误使用合成 resolver 验证，真实 PAC/WPAD 网络环境尚待验收。
旧格式升级时保留原先 active credential。状态检查只读本地凭据；实际请求或刷新目录时
才刷新即将过期的 token。临时网络错误保留凭据，终态 refresh 错误清空令牌并要求重新登录。

## 会话内切换

```text
/model
/model --refresh
/model chatgpt/<slug>
/model deepseek/deepseek-flash
/model Flash
```

REPL、TUI 命令和 RPC set_model 共用 ModelSelection：
完整 provider/model 优先，其次唯一 ID，再匹配唯一的名称片段。多项匹配提示完整路由，
不猜测 provider。明确提供 provider/model 时允许模型尚未列入咨询性目录。

选定模型后先检查本地凭据，再修改当前路由；失败保留原模型和历史。跨 provider 成功切换时
推理强度恢复目标 provider 的默认值，避免沿用另一家的专用档位。RPC 在回合进行中
拒绝切换。工厂每轮解析路由，实际请求、上下文窗口和工具输出预算均使用当前模型；
切换到较小窗口时先按新预算裁剪历史，未知窗口不会沿用上个模型的预算。

交互启动会刷新已配置 provider 的目录，刷新失败仅报告并保留已有快照。
/model --refresh 返回新目录给 TUI，参数补全使用 provider/model 并支持名称搜索。
ChatGPT 目录从 /v1/models 取 visibility:list 项，保留服务端顺序，不猜测订阅可用模型或价格。
已知的 gpt-6.1-sol 元数据来自官方文档：上下文窗口 1,050,000 tokens，默认推理强度 medium。
静态元数据只补充能力描述，不将模型加入账户可用目录。

## 推理强度与额度

```text
/thinking
/thinking high
/thinking default
/usage
```

`/thinking` 显示当前档位和已知支持值；gpt-6.1-sol 支持 low、medium、high、xhigh、max。
`default` 移除显式覆盖，使用模型默认值。启动时也可传 `--thinking high`。
`Di.Cli/ModelSelection.cs` 的 SetReasoningAsync 依据模型元数据校验，成功后同步实际循环选项；
无元数据的 ChatGPT 模型仅做候选值检查，最终由服务端校验。跨提供商切换或目标模型不支持
当前档位时恢复默认值。RPC 在回合进行中拒绝修改模型或强度。

`/usage` 提供官方 [ChatGPT Usage](https://chatgpt.com/settings/usage) 入口。
公开 SIWC 文档没有五小时/每周剩余额度查询 API，因此不在本地推算剩余百分比。
本地 token 统计不能代表订阅剩余额度，具体窗口以账户 Usage 页面为准。

## 缓存计量与回放

gpt-6.1-sol 的缓存读取与写入分别计量。`Core/Providers/ChatGpt/ChatGptAdapter.cs`
从 input_tokens_details 读取 cached_tokens 与 cache_write_tokens；普通输入量扣除二者，
`Core/Llm/TokenUsage.cs` 合计输入时再加回，避免重复计数。CLI/TUI 在有写入时显示 cache_write。

首轮、切换模型后首次请求为 cache_read=0 可以正常发生。GPT-5.6 及后续模型要求至少
1024 个可复用的可见前缀 tokens；输入总数 1810 并不说明有这么长的相同前缀。
模型、推理强度、工具定义或前缀变化均可能导致缓存未命中，简单问候的 reasoning=0
也不能单独说明推理配置失效。旧日志没有缓存写入字段，不能据此还原服务端未命中的原因。

`Core/AgentLoop/AgentRunner.cs` 创建运行器级 SessionId，经 AgentRequest、ReAct、
ModelRequest 和 `Core/Llm/ChatModelClient.cs` 传给翻译器，作为哈希化 prompt_cache_key。
对 GPT-5.6 及后续模型它是可选的会话隔离标识，不保证缓存命中。
`Core/Providers/ChatGpt/ChatGptTranslator.cs` 原样回放终态 response.output 中的条目，
保留消息边界、工具调用与 reasoning；显示用的归一化块不再重复发送。
旧历史没有原始 output 时沿用兼容回放。store:false 不等于禁用提示缓存。
不添加填充、预热或显式缓存写入请求；修改推理强度仍可能导致前缀变化。

**订阅（SIWC）通道的缓存实测**：官方[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
要求 store:false + stream:true 的无状态请求（HTTP 上不传 previous_response_id）；
[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
把 prompt_cache_retention 列为不支持字段，且未声明该通道提供提示缓存。
实测在固定前缀（相同 runner/会话键/工具集、连续三条相同请求）下，usage 始终
无 cached_tokens / cache_write_tokens（cache_read=0，首请求也无 cache_write），
而 gpt-6.1-sol 在付费 API 上的缓存能力见[模型页](https://developers.openai.com/api/docs/models/gpt-6.1-sol)。
说明该通道当前不提供缓存计量：本地 cache_read=0 属预期，不代表 Di 请求拼装错误；
缓存命中率类优化主要作用于会上报缓存的提供商（如 DeepSeek，见 docs/modules/deepseek.md）。
需最终确认时可抓 response.completed 事件里的原始 usage 字段。

## Responses

请求使用 store:false、stream:true 和完整 input 历史，system 转 developer。
本地工具置于 di namespace，支持工具参数增量、结果和 encrypted reasoning 回放。
SSE 缺少终态即报错；response.failed、response.incomplete 保留失败语义。
HTTP 错误保留状态、响应体和 request ID。显式设置不支持的采样、penalties、
max token 或 stop 选项会在请求前报 UNSUPPORTED_OPTION。

## 参考与验证

- `packages/coding-agent/src/core/auth/chatgpt-auth.ts`：`ChatGptAuth`
- `packages/coding-agent/src/core/auth/credential-store.ts`：`CredentialStore`
- `packages/coding-agent/src/core/auth/lock-provider.ts`：`NativeOsLockProvider`
- `packages/coding-agent/src/cli/auth-command.ts`：`defaultChatGptStore`、`runAuthCommand`
- `packages/coding-agent/src/cli/provider-runtime.ts`：`createDefaultProviderRuntime`
- `packages/ai/src/providers/chatgpt/adapter.ts`：`ChatGptAdapter`
- [官方注册与授权](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [官方刷新与撤销](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [官方模型与 Responses](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [官方通道限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [gpt-6.1-sol 能力](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [提示缓存计量与匹配规则](https://developers.openai.com/api/docs/guides/prompt-caching)

本地测试使用模拟服务与 loopback 回调，覆盖 OAuth 契约、刷新串行化、失败保留凭据、
跨 provider 路由、切换失败、busy 拒绝、动态预算、强度修改、缓存读写计量、原始 output 回放、
会话标识传递和 TUI 目录解码。测试不发送真实推理请求。
真实账户的本地凭据刷新通过生产 CredentialStore、OS 锁和 Windows 静态代理完成。一次 `gpt-6.1-sol`、`low` reasoning smoke 返回 `finish=stop`，usage 为输入 11、输出 5、合计 16 tokens；此前不支持的 `minimal` 档位曾返回 HTTP 400。该 smoke 禁用重试，仅记录状态和用量，不保存响应正文或凭据。
