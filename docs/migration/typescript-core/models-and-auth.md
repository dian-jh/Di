# TypeScript Core 迁移：模型与认证

> 状态：迁移实施指南；本文描述目标实现和验收要求，不表示 TypeScript 版本已存在。
> 迁移基线：Di `09f4e0816c1b2dc42461e79a968b46e811d3880c`；Pi 只读参考：
> `7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333`。不得把 Pi 当前行为当作 Di 协议。
> 架构包边界和共享接口以 [`docs/migration/typescript-core/architecture.md`](architecture.md) 为准；
> 本文只规定模型/provider/auth 迁移契约。loop 与历史边界见
> [`loop-and-state.md`](loop-and-state.md)，会话持久化兼容见
> [`sessions-and-compatibility.md`](sessions-and-compatibility.md)。

## 范围与目标位置

目标模型词汇与 provider 协议位于未来 `packages/ai/`（包名 `@di/ai`）。纯模型调用循环由未来
`packages/agent/`（`@di/agent`）消费其流接口；Node 文件、凭据和 OAuth 生命周期由未来
`packages/coding-agent/src/core/auth/` 等宿主代码提供。以下路径均为**未来路径**，须先由架构文档
确认公共导出名。既有 C# 路径是目前的事实依据。

Di 当前已有 DeepSeek 与 ChatGPT provider。迁移是协议保真重写：保留 Di 的 wire DTO、null/缺省
语义、流事件顺序、重试范围、错误语义、缓存字段、OAuth 存储并发保证。Pi 的同类实现仅作 API
形态及可复用性参考。禁止为“和 Pi 一致”而改变 Di 当前协议。

## C# 到 TypeScript 的符号映射

| 当前 Di（已存在） | 未来 TypeScript 归属 | 迁移职责 |
|---|---|---|
| `Core/Llm/ChatMessage.cs`, `ContentBlock.cs`, `ChatRole.cs`：`ChatMessage`、`IContentBlock`、`OpaqueBlock` | `packages/ai/src/types/messages.ts`, `content.ts`（未来） | 映射架构契约 `AgentMessage`/message union、`ContentBlock`；未知块无损回放，不混入 provider wire DTO |
| `Core/Llm/StreamChunk.cs`：`StreamChunk.BlockStart/TextDelta/ReasoningDelta/ToolCallDelta/BlockEnd/ResponseInfo/Usage/Finish` | `packages/ai/src/types/stream.ts`（未来） | 迁移为 provider 内部低层 `ProviderChunk`；保留 index、原始 argument delta、可空 response id、显式终态 |
| `Core/Llm/IChatModel.cs`：`IChatModel`, `ModelRequest`, `ModelResponse`, `ModelEvent` | `packages/ai/src/types/model.ts`、`packages/ai/src/types/stream.ts` | `ChatModel.stream(request, signal?): AsyncIterable<ModelEvent>`；共享请求/事件由这些源文件定义 |
| `Core/Llm/ChatAdapter.cs`, `LlmRuntime.cs`, `ILlmService.cs` | `packages/ai/src/providers/` 与 `model.ts`（未来） | 实现统一 `ChatModel` 接口及 provider registry；宿主注入认证参数 |
| `Core/Llm/ChatModelClient.cs`, `ChatAssembler.cs` | `packages/ai/src/stream-assembler.ts`（未来） | `ProviderChunk → assembler → ModelEvent`：向上游及时发 text/reasoning/tool-call delta，最后发 `completed` 并携带完整 `ModelResponse`；低层 chunk 不暴露给 loop |
| `Core/Llm/RetryingChatModel.cs` | `packages/ai/src/retry/`（未来） | 仅在一次模型流尚未触发任何工具执行前重试；不能重放已开始执行工具的 Agent 回合 |
| `Core/Llm/TokenUsage.cs`, `CostAccounting.cs`, `ModelCatalog.cs`, `LlmException.cs` | `packages/ai/src/usage.ts`, `catalog.ts`, `errors.ts`（未来） | 对应架构词汇 `TokenUsage`、`FinishReason`、`LlmFailure` 和模型引用；保留可空、费率空值，不把未知当零 |
| `Core/Providers/DeepSeek/DeepSeekAdapter.cs`, `DeepSeekTranslator.cs` | `packages/ai/src/providers/deepseek/`（未来） | DeepSeek HTTP/SSE、wire 翻译、错误/超时映射 |
| `Core/Providers/ChatGpt/ChatGptAdapter.cs`, `ChatGptTranslator.cs` | `packages/ai/src/providers/chatgpt/`（未来） | Responses 无状态请求、流事件、usage/raw output 回放 |
| `Core/Providers/ChatGpt/ChatGptAuth.cs`, `ChatGptCredentialStore.cs` | `packages/coding-agent/src/core/auth/`（未来） | 本机 OAuth、令牌轮换和安全持久化；不得把文件系统存储塞进通用 `@di/ai` |

本段描述职责映射，不另行定义共享接口。实现开始前由 architecture 文档的公共接口名替换表中
暂定目录名；本叶子文档不能成为第二份接口权威。

## 必须守住的模型层语义

### 归一化词汇与流顺序

- `reasoning` 是独立内容，不拼进可见文本；历史中的 reasoning 原样重放。未知 content block 用
  opaque/raw 形式保存，不能因 TS 联合类型未识别就丢弃。
- `tool_call` 的参数按增量接收原始 JSON 文本。流结束前它可能是无效/不完整 JSON；只有形成完整
  block 后才交 Agent loop 执行。provider 不得在 delta 阶段解析、修补或重新序列化参数。
- provider 内部流协议允许 `ProviderChunk.BlockStart`、delta、`BlockEnd`、`ResponseInfo`、`Usage`、
  `Finish`；低层 `Usage` 必须在 `Finish` 前，Finish 后不得再有 chunk。遇到传输/协议错误抛结构化错误，
  带内终态错误使用现有 `Finish(Error/Aborted)` 语义，不能同时发送终态再继续。
- assembler 按块 index 装配；多个 tool call 并发交错时不能串到同一个 buffer。没有 response id 时保持
  null。对 loop/TUI 暴露的 `ModelEvent` 仅是高层 text/reasoning/tool-call delta 与 `completed`；
  completed 携带一次模型调用完整 `ModelResponse`（本次 usage/cost），Agent loop 再计算回合累计值。
  TS 高层不再单独发 `Usage` event；它留在 `completed.response.usage`，避免把低层 provider protocol
  事件泄漏到 loop。
- C# 的可空字段在 TS 表达成 `T | undefined`/可选字段；序列化时省略未设置值，不要改成 `null`、
  `0`、`[]` 或空字符串。显式 null 与未提供若 wire DTO 有区别，需分别建模。

### Token 与缓存计量

`TokenUsage` 的 input 是未命中缓存的输入，`CacheReadTokens` / `CacheWriteTokens` 表示输入缓存计量；
`ReasoningTokens` 是 `OutputTokens` 的子集，不能再加进 output 或 total。它与 cache 字段不是同一计数轴；
cache 字段可空；合计计费输入时
才按既有实现合并 cache read/write。`Add` 需逐字段保留 null：两项都
缺失的结果仍为缺失，不得被初始化为零。DeepSeek 读取 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
（兼容 `prompt_tokens_details.cached_tokens`）。ChatGPT Responses 读取
`input_tokens_details.cached_tokens` 和 `cache_write_tokens`，普通 input 扣除二者避免重复；当前 C# adapter
对缺失的 cached_tokens 和 output_tokens 明确归一为 0，对 cache_write_tokens、total_tokens、reasoning_tokens
则保留可空。TS 必须按 fixture 保持这些既有默认，不得进一步把所有缺省字段全补零。

`ModelResponse` 的 `responseId`、请求开始 Unix 毫秒 timestamp、单调时钟 duration、`cost` 可空行为
保持兼容。没有费率时 cost 为 undefined；不要把目录里的占位费率解释成可验证的价格。

### 重试边界

当前 C# `RetryingChatModel.StreamAsync` 在枚举中途捕获 retryable 错误并重新枚举，即使前面已经向调用者
yield 了 text/reasoning/tool-call delta；这可能重复展示前缀。TS 迁移明确修正该边界：不缓冲整条流（保留
实时输出），只允许在第一个 `ModelEvent` 发出前重试；一旦发出任一 delta，后续 retryable 错误直接向上
抛出，不重放已发布内容。重试仅发生在单次模型调用内，Agent loop 一旦调用任一工具或回填工具结果，
不得重跑该轮。该行为差异是避免重复输出与重复副作用的有意取舍，测试需分别证明“首事件前可重试”、
“首事件后不重试”及“工具最多执行一次”。尊重 Retry-After、有限次数、指数退避、抖动和 AbortSignal；
调用者取消不重试。

## DeepSeek 协议边界

现状权威：`Core/Providers/DeepSeek/DeepSeekAdapter.cs`、`DeepSeekTranslator.cs`、
`DeepSeekChatRequest.cs`、`DeepSeekChatResponse.cs`、`DeepSeekAdapterConfig.cs`，测试在
`Di.Tests/Providers/DeepSeek*Tests.cs`。具体模块说明见 [`docs/modules/deepseek.md`](../../modules/deepseek.md)。

未来迁移顺序：先抄录 C# serializer 产生的请求 JSON fixture，再做纯翻译器，再做流式 HTTP adapter。
保留以下行为：

1. SSE 按 UTF-8 字节流分帧，支持 CRLF/LF、event 多行 data、注释行和 chunk 边界落在任意字节；
   `[DONE]` 是 DeepSeek 结束标记。坏 JSON chunk 按现有策略跳过；意外 EOF/缺 `[DONE]` 是可重试
   Connection 错误，不可假装正常 stop。
2. 保留 `usage`、reasoning_content、content、tool_calls 的翻译与既有 finish reason 表。带 tools 的
   assistant 历史必须回传 reasoning_content；think 模式下 required/指定函数工具选择的限制，
   reasoning_effort 与 disabled 冲突，以及 unsupported effort 错误均由 translator 显式处理。
3. 未设置的 stop/tools/tool_choice 等字段保持省略，不序列化成空数组/空对象。字段为空与字段未设置
   不能被 TS 默认值混为一谈；请求稳定前缀依赖字节级相同 JSON。
4. 429、401/403、HTTP 错误体、Retry-After、连接错误、header wait 超时（默认 60s）和流式空闲超时
   （默认 60s）翻译为既有结构化错误。不能给长推理流增加总时长 timeout；AbortSignal 取消不当作
   超时重试。
5. 保留缓存命中/未命中字段优先级、reasoning token 计量及首个 response id 的 ResponseInfo。

Pi pinned 参考：[`deepseek.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/ai/src/providers/deepseek.ts)、
[`deepseek.models.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/ai/src/providers/deepseek.models.ts)、
[`provider-retry.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/ai/src/utils/provider-retry.ts)。
参考源码可能对 Di 约定不同，fixture 与 Di 测试优先。

## ChatGPT Responses 与 OAuth

现状权威：`Core/Providers/ChatGpt/ChatGptAdapter.cs`、`ChatGptTranslator.cs`、
`ChatGptAuth.cs`、`ChatGptCredentialStore.cs`、`Di.Cli/ChatGptAuthCommand.cs`；
协议说明见 [`docs/modules/chatgpt.md`](../../modules/chatgpt.md)。仅使用模拟 HTTP、临时凭据目录和
loopback 测试；迁移时不得读用户凭据、复用真实 token 或登录真实账户。

### Responses wire 与 SSE

- 请求是 `store:false`、`stream:true`、完整 input 历史；不发送 `previous_response_id`。system 转
  developer；工具放入 Di namespace。明确不支持的 temperature/top_p/penalties/max token/stop 选项
  在发请求前产生 `UNSUPPORTED_OPTION`，不静默忽略。
- `ChatGptTranslator` 需维持消息边界、工具调用、reasoning 与 encrypted reasoning 的可回放信息。
  若终态含原始 `response.output`，将其保留为 opaque/raw output 并原样用于后续历史；已归一化的
  显示块不能重复发送。旧历史没有 raw output 时遵循 C# 兼容回放路径。
- 处理 Responses SSE 的 text、reasoning、function/tool arguments delta、usage、response id、
  `response.completed`、`response.failed`、`response.incomplete`。区分 provider 终态与 TCP EOF：
  SSE 没有终态事件即协议截断错误，不能补造成功 Finish；failed/incomplete 保持各自错误/停止语义。
- 非 2xx 错误保留 status、body、request ID 与 Retry-After；stream 中间连接断开按现状映射结构化
  错误。取消立即结束读取和 reader，不重试。
- usage 可空字段按现有 C# adapter 的逐字段规则归一，不能把 `TokenUsage` 可空字段统一补零。session prompt-cache key 按现有链路由 AgentRunner
  的 session id 派生；这是提示缓存提示键，不承诺命中，也不能改变用户可见 transcript。

Pi pinned 参考：[`openai-responses.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/ai/src/api/openai-responses.ts)、
共享 Responses 转换应先在该提交中由实现者核对实际路径/API；ChatGPT OAuth 参考为
[`openai-chatgpt.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/ai/src/auth/oauth/openai-chatgpt.ts)。
不得因为 Pi 使用某 SDK 就将 SDK 加为默认依赖；先证明其版本、MIT 许可、实际 API 与 Di wire 行为
兼容，且审查可选方案。Pi 整包不是 runtime 依赖。

### OAuth PKCE、轮换与原子凭据写入

`ChatGptAuth` 的本机授权为宿主能力，不属于通用模型词汇。必须保持：

现有实现入口明确：`ChatGptCredentialStore.LockAsync` 在 Windows 上给目录设置当前用户 ACL、Unix
目录 0700，并用 `FileShare.None` 持有 `session.lock`；`UpdateAsync` 在锁内读、执行 refresh/login/logout
变更并写临时文件，Unix 临时文件为 0600 后原子替换 `credentials.json`。迁移要保留这些保证，但 Node
没有相同的跨平台 API；不能把 `open('wx')` 文件存在性误说成等价于 `FileShare.None`。

1. 注册/登录只用 loopback `127.0.0.1` 的随机端口，限时回调；校验回调 path、随机 `state`、授权
   code、issued client ID、PKCE verifier/challenge、必需令牌字段、正数 expires_in 和
   `chatgpt.tokens.use.direct` scope。ID token 只作授权提示保存，不把它说成已验证身份；不增加 JWKS
   或账户身份体系。无效新响应不得覆盖旧的有效 credential。
2. access token 接近过期（现状提前 3 分钟）时才刷新。令牌轮换在一个锁保护的事务中完成：获取跨进程
   排他锁 → 锁内重新读取最新凭据 → 检查是否仍需刷新 → 使用 refresh token → 校验响应 → 原子替换
   凭据文件。锁必须覆盖读、网络刷新和提交，避免两个进程同时消费一次性 refresh token。锁等待支持
   AbortSignal、退避和合理上限；取消不能误删凭据。
3. 更新写到同目录唯一临时文件，flush/close 后原子 rename/replace；异常清理临时文件且旧文件仍完整。
   Windows 使用当前用户 ACL；Unix 目录 0700、文件 0600。目录、临时文件和锁文件权限都要审查。若无法
   应用/验证 ACL 或 POSIX mode，必须 fail closed 并拒绝保存 token，不能只记 warning 后继续声称安全等价。
   禁止日志输出
   token、authorization header、code、verifier 或 refresh body。
4. 临时网络/5xx 刷新失败保留原凭据并返回可恢复错误；终态 refresh token 拒绝按当前语义清空令牌、
   要求重新登录。logout 撤销 refresh token，清除令牌但保留 host/client 注册信息。status 只读，不
   为显示状态而刷新。
5. 所有写操作通过单一 `UpdateAsync`/事务入口；兼容旧格式升级时原子迁移且保留旧 active credential。
   文件锁可跨进程且不依赖 E 盘固定路径。测试使用并行独立 store 实例验证锁语义。

Node 建议实现：`node:fs/promises` 写同目录随机临时文件，先设置受限权限，再写入、`FileHandle.sync()`、
close、`rename()`；Windows ACL 通过经过审查的 Windows 原生 API/小适配层（例如 `SetNamedSecurityInfoW`
设置 DACL，并查询回读）设置并确认。权限设置
或验证失败就拒绝 token 写入，保持旧文件不变。普通 Node `open(lock, 'wx')` 锁文件的 PID/TTL 检查
不能可靠判定 owner 已死（PID reuse、暂停进程、竞态 unlink 均会误删活锁），因此不得自动按年龄或 PID
删除。首选经审查的 OS advisory lock：POSIX `flock`/等价锁，Windows `LockFileEx` 或 share-mode
exclusive handle，锁覆盖读、refresh 网络调用和提交。若没有可接受的跨平台实现，安全 fallback 是锁无法
取得时 fail closed、保留凭据并报可恢复错误；陈旧锁只允许经明确离线人工恢复流程处理。不能用进程内
mutex 或未经证明的 stale-lock 自动回收冒充跨进程安全。多进程竞争测试是验收门。

Pi pinned OAuth 参考同上。依赖/复用是决策门：先核对 lock 中确切版本、API/类型、MIT/license、
Node 22.19 可用性、ESM 兼容、维护状态和依赖树；保留小型本地适配器以隔离其 API。没有评估记录
前不引入 SDK 或新 runtime。

## 依赖决策门

仓库已有 `tui/package-lock.json` 锁定 TypeScript `5.9.3`、`@types/node` `22.20.5`、`pi-tui`
`1.2.0`。目标最低 Node `>=22.19`，本机核对为 `24.16.0`。首期沿用这些已经锁定的版本，不从
Pi `package.json` 猜版本，也不跟 Pi TS7。所有新 npm 依赖必须先核对真实 API/版本/许可、Windows
支持、Node 最低版本、依赖树，再由依赖 PR 固定 lockfile；模型协议本身优先用内置 `fetch`、Web
Streams、`node:crypto` 和小型自有 DTO。Pi 包可作为对照源码，不整体作为 `@di/coding-agent` runtime。

## 红测试清单与实现顺序

先为每个单元写 node:test 红测；所有网络测试只用 injected fetch/loopback 模拟服务，所有 OAuth 存储
测试用临时目录和合成 token。建议顺序：

1. 消息词汇/可空字段 JSON fixture：reasoning 与 text 分离、opaque 原样回放、undefined 不生成 null/0/[]。
2. ChatAssembler：交错 block index、部分 tool arguments、usage-before-finish、finish 后 chunk 拒绝。
3. DeepSeek translator fixture：请求 null/省略/空数组、reasoning 历史、tool choice 限制、usage cache 字段、finish reason。
4. SSE parser 边界：任意字节切分、CRLF、多行 data、注释/空帧、坏 JSON、`[DONE]`、EOF 缺终态。
5. ChatGPT Responses fixture：无状态请求、system→developer、完整历史、unsupported option、各类 delta、failed/incomplete、缺终态、usage cache 字段和 raw output 回放。
6. 重试：429/Retry-After、超时/连接/5xx；AbortSignal 不重试；对外发布过 delta 的流不重放；工具已运行后 loop 不重跑。
7. OAuth：state/PKCE/path/client id/scope/token 字段校验，拒绝坏响应时旧凭据不变；expiry 3 分钟边界、轮换令牌并发竞争只刷新一次。
8. 文件持久层：原子替换中断、临时文件清理、Unix mode/Windows ACL adapter、多个进程更新无丢失、过期锁回收不误删活锁、日志脱敏。

### 分片实施与停止条件

每个分片独立完成红测、实现、绿测，再开始下一片；不得把模拟成功当作平台能力证明。

1. 先只实现 `ProviderChunk` 和 assembler 的内存单测。停止条件：完成事件缺失/重复、usage 不在
   `completed`、raw tool JSON 被重序列化或 finish 后仍有数据时，禁止接 provider。
2. 接 DeepSeek fixture 与注入式 fetch。停止条件：请求 JSON 有任何缺省字段漂移、SSE 缺 `[DONE]` 被判
   成成功，或传输错误被裸异常吞掉时，禁止接 TUI。
3. 接 ChatGPT Responses fixture。停止条件：raw output 回放改变、failed/incomplete 被改成 Stop、缺终态
   成功、unsupported 参数被静默丢弃时，禁止进入账户能力工作。
4. 单独实现 retry wrapper。停止条件：首个 `ModelEvent` 后仍重试、取消被重试、工具执行记录大于 1 时，
   禁止合入 provider 集成。
5. OAuth 先完成纯回调/PKCE/令牌响应验证，不读取任何真实凭据。停止条件：坏响应覆盖旧数据、错误 scope
   被接受、真实账户/token 出现在测试或日志中时，立即停止该单元。
6. credential storage 依赖采用精确版本 `koffi@2.14.1`（MIT）：Windows 通过 `CreateFileW` +
   `LockFileEx`，POSIX 通过 Node `FileHandle.fd` + libc `flock`。Koffi 发布包包含 Windows/Linux/macOS
   预编译构建；本机 Node 24.16 / Windows x64 已验证 FFI ABI、双进程互斥、持锁进程强杀后自动释放，
   以及双进程合成 refresh 仅消费一次轮换 token。Linux/macOS 的 `flock` 分支也已通过三平台 CI 的真实
   子进程互斥、持锁进程终止与合成 refresh 测试；真实账户 smoke 的平台范围见 `progress.md`。
   运行时缺失 FFI、无法打开/取得/释放锁时均 fail closed，凭据保持不变。
   不得用 mkdir/lockfile TTL、PID-only 判断、内存 mutex 或只记录 ACL warning 的实现替代。
   DeepSeek 的 Windows `UseSystemProxy` 使用固定版本 `undici@7.30.1`（MIT，Node >=20.18.1），
   通过 `ProxyAgent` 路由当前用户静态 HTTP/HTTPS 代理；本机 Node 24.16 loopback 已验证 CONNECT、
   成功响应、代理错误和取消。Internet Settings 与 `Connections\\DefaultConnectionSettings` flags
   由只读 `reg.exe query` 读取；PAC/WPAD 经 Windows PowerShell 的系统代理解析器处理，支持取消及 15 秒超时，未知 flags/解析错误 fail closed；真实 PAC/WPAD 网络环境尚待验收。WinHTTP Koffi 输出指针
   探针在本机曾异常退出，生产路径不使用该未验证 FFI。POSIX 环境代理支持 HTTP/HTTPS/SOCKS4/4a/5；
   macOS 无代理环境配置时支持静态系统设置发现，PAC/WPAD 自动解析仍失败关闭。
   ChatGPT 与显式启用系统代理的 DeepSeek 共用路由器；支持边界及环境变量规则见
   [`DeepSeek 模块文档`](../../modules/deepseek.md#usesystemproxy-in-the-typescript-host)。
7. 最后才接 `@di/coding-agent`。停止条件：任一 provider fixture、跨进程竞争、权限拒绝、retry 安全门失败，
   不得标记模型/auth 阶段完成。

完成判据：C# 现有 provider/auth 测试矩阵在 TS 有等价的无账号离线 fixture；协议边界全通过；deepseek
与 ChatGPT 的调用经模拟服务可流式完成；缺终态为失败；reasoning/raw output/cache/null 保真；并发
refresh 不重复消费 token；无真实凭据/账号读取或请求；实现不会从 Agent loop 重放已执行工具的回合。

关联：[`architecture.md`](architecture.md)、[`loop-and-state.md`](loop-and-state.md)、
[`sessions-and-compatibility.md`](sessions-and-compatibility.md)、
[`docs/modules/llm.md`](../../modules/llm.md)、[`docs/modules/deepseek.md`](../../modules/deepseek.md)、
[`docs/modules/chatgpt.md`](../../modules/chatgpt.md)、[`docs/modules/agent-loop.md`](../../modules/agent-loop.md)、
[`docs/modules/sessions.md`](../../modules/sessions.md)。
