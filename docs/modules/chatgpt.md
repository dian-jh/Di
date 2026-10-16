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
Windows 使用当前用户目录 ACL；Unix 为目录 0700、文件 0600。存储仅有一个
UpdateAsync 写入口，文件锁覆盖读取、刷新和原子替换，避免跨进程重复使用轮换令牌。
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
ChatGPT 目录从 /v1/models 取 visibility:list 项，保留服务端顺序，不猜测订阅可用模型、
上下文窗口或价格。

## Responses

请求使用 store:false、stream:true 和完整 input 历史，system 转 developer。
本地工具置于 di namespace，支持工具参数增量、结果和 encrypted reasoning 回放。
SSE 缺少终态即报错；response.failed、response.incomplete 保留失败语义。
HTTP 错误保留状态、响应体和 request ID。显式设置不支持的采样、penalties、
max token 或 stop 选项会在请求前报 UNSUPPORTED_OPTION。

## 参考与验证

- 本地 pi：packages/ai/src/auth/oauth/openai-chatgpt.ts
- 本地 pi：packages/coding-agent/src/core/model-resolver.ts
- 本地 pi：packages/coding-agent/src/core/agent-session.ts 的 setModel
- [官方注册与授权](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [官方刷新与撤销](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [官方模型与 Responses](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [官方通道限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

本地测试使用模拟服务与 loopback 回调，覆盖 OAuth 契约、刷新串行化、失败保留凭据、
跨 provider 路由、切换失败、busy 拒绝、动态预算和 TUI 目录解码。
真实账户访问权限仍需完成浏览器登录后验证。
