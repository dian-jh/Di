# Core.Providers.DeepSeek —— DeepSeek 适配器

> 模块文档。回答"DeepSeek 的厂商怪癖收敛在哪里、SSE 怎么解析、缓存优化做了什么、模型目录与鉴权在哪"。
> 上一级入口：`docs/README.md`；抽象侧见 `docs/modules/llm.md`。

## 目的与职责

DeepSeek 提供方的**线格式适配器**：HTTP/SSE 传输、chunk 归一化、错误翻译、鉴权。
核心原则——**所有 DeepSeek 怪癖的唯一居所是 `DeepSeekTranslator`**，业务与宿主不认识具体厂商；
加厂商 = 加一个 DI 扩展 + 一个适配器。

## 实现原理

### 传输（`Core/Providers/DeepSeek/DeepSeekAdapter.cs`）

- 手写最小 SSE 分帧；坏 chunk 跳过不崩流。
- `TranslateChunk`：usage / reasoning / text / tool-call / finish 的归一化；首个带 id 的 chunk 发
  `ResponseInfo`（响应标识，用于追溯 / 日志）。
- 错误翻译：非 2xx → 结构化 `LlmException`（429 → RateLimited、401/403 → MissingCredential）。
- **流式超时策略**（历史 bug：`HttpClient.Timeout` 覆盖整个流式正文读取，60s 总时长硬卡把长响应
  掐断，报 "The response ended prematurely." 且不可重试）。现在 HttpClient 不设总时长超时
  （`DeepSeekServiceCollectionExtensions.cs`），改为两层<b>请求内</b>超时：
  - 响应头等待超时 `DeepSeekAdapterConfig.TimeoutSeconds`（默认 60s，`SendAsync`）——服务器迟迟
    不开始响应时快速失败为可重试 `Timeout`，而非无限等；
  - 流式空闲超时 `DeepSeekAdapterConfig.StreamIdleTimeoutSeconds`（默认 60s，`StreamAsync`）——
    连续两帧之间超过该时长视为流挂起，抛可重试 `Timeout`。长思考 / 长输出<b>不设总时长上限</b>。
- **流式中断一律可重试**：连接被掐断（`HttpIOException` / `IOException` / `HttpRequestException`）
  与 EOF 未收到 `[DONE]`（协议截断）都抛可重试 `Connection`，让 `RetryingChatModel` 整体重试，
  而不是把回合打死（历史 bug 的裸抛路径）。

### 线格式翻译（`Core/Providers/DeepSeek/DeepSeekTranslator.cs`，厂商怪癖唯一居所）

1. 带 tools 时历史 reasoning_content 必须完整回传，否则 400。
2. 思考模式下 tool_choice=required / 指定函数会 400。
3. 思考模式下 reasoning_effort 不应与 type=disabled 同现。
4. 未设置的集合不能序列化成 `[]`（破坏服务端前缀缓存）。
5. strict 模式需要 beta 域名；不支持的推理强度抛 `UNSUPPORTED_OPTION`，不静默降级。

### 缓存优化（已实现）

- 未设置的集合可空序列化，避免 `"stop":[]` 之类让缓存 key 变化 → 全部 miss。
- usage 顶层字段 `prompt_cache_hit/miss_tokens` 建模正确（`cached_tokens` 嵌套兜底）。
- `TokenUsage.Add` 的 `SumOrNull` 保留缓存 / 推理字段（修复 UI 恒显 0 的根因）。
- **请求布局**：稳定 system prompt + 完整轨迹在前（字节稳定前缀），易变 SystemContext 在末尾
  （配合 `AgentRunner` 的环境快照 append-on-change，见 `docs/modules/agent-loop.md`）。

### 目录与鉴权

- **目录（2 个模型，纯数据）**：`deepseek-flash`（0.28 / 0.42 / 0.07 每百万）与 `deepseek-v4-pro`
  （1.20 / 4.00 / 0.30）——**费率是占位值，需按官方最新定价核对**（数据，非代码）。
- **鉴权**：`Auth` = `DEEPSEEK_API_KEY` 环境变量；`ResolveApiKeyAsync` 覆盖为 config
  （`DeepSeek:ApiKey`）优先、环境变量兜底，均在请求时解析。

## 当前 TypeScript 代码入口

| 文件（仓库根相对路径） | 职责 |
|---|---|
| `packages/ai/src/providers/deepseek/adapter.ts` | HTTP/SSE 请求、usage、错误与流超时处理 |
| `packages/ai/src/providers/deepseek/translator.ts` / `wire.ts` | provider wire translation and DTOs |
| `packages/ai/src/catalog.ts` | 当前目录中的模型窗口与成本元数据 |
| `packages/coding-agent/src/cli/provider-runtime.ts` / `windows-system-proxy.ts` | 生产模型路由、Windows 静态用户代理配置和请求 dispatch |
| `packages/ai/test/` | DeepSeek adapter、翻译、请求/响应与故障测试 |

### `UseSystemProxy` in the TypeScript host

The host reads current-user Windows Internet Settings with fixed-argument `reg.exe query` calls. It supports configured static HTTP/HTTPS proxy endpoints and WinINET bypass entries, including `*.host` wildcards and `<local>`. If the system proxy setting is disabled, requests use the direct route. PAC or WPAD flags cause a clear error because automatic proxy rule execution is not implemented. Missing or malformed connection flags also fail closed; the host does not assume that an unknown configuration means direct access. The implementation does not modify Windows proxy settings.

Static routing uses exact dependency `undici@7.25.0` (`MIT`) with its own `fetch` and `ProxyAgent`; it does not change Node's global dispatcher. Loopback tests cover successful CONNECT, proxy error, cancellation, bypass, and direct mode. PAC/WPAD remain a compatibility gap relative to Windows automatic proxy behavior.

下表是固定 C# 迁移基线位置，供行为差异核对。

## C# 基线代码入口（行为参考）

| 文件（相对仓库根） | 职责 |
|---|---|
| `Core/Providers/DeepSeek/DeepSeekAdapter.cs` | HTTP/SSE 传输 + chunk 归一化 + 错误翻译 + 目录 + 鉴权 |
| `Core/Providers/DeepSeek/DeepSeekTranslator.cs` | Core 词汇 ↔ DeepSeek 线格式（5 条怪癖唯一居所） |
| `Core/Providers/DeepSeek/DeepSeekChatRequest.cs` / `Core/Providers/DeepSeek/DeepSeekChatResponse.cs` | 线格式 DTO（私有，不对外） |
| `Core/Providers/DeepSeek/DeepSeekDefaults.cs` | 默认值（baseUrl 等） |
| `Core/Providers/DeepSeek/DeepSeekAdapterConfig.cs` | 配置段绑定（`ApiKey` / `BaseUrl` / `DefaultReasoningEffort` / `StrictTools` / `UseSystemProxy` / `TimeoutSeconds` / `StreamIdleTimeoutSeconds`） |
| `Core/Providers/DeepSeek/DeepSeekServiceCollectionExtensions.cs` | DI 注册扩展（`AddDeepSeek`） |

## 关键符号

- `DeepSeekAdapter`（`ChatAdapter` 子类）、`DeepSeekTranslator`
- `DeepSeekAdapterConfig`、`DeepSeekChatRequest` / `DeepSeekChatResponse`、`DeepSeekDefaults`

## 已实现能力与测试

| 能力 | 落点 | 测试 |
|---|---|---|
| HTTP/SSE 传输 + 分帧（坏 chunk 跳过） | `DeepSeekAdapter` | `Di.Tests/Providers/DeepSeekTranslatorTests.cs` 等 |
| 流式超时与中断兜底（空闲超时 / 截断 / 传输中断 → 可重试 `Timeout` / `Connection`） | `DeepSeekAdapter.StreamAsync` / `SendAsync` | `Di.Tests/Providers/DeepSeekAdapterStreamTests.cs` |
| 错误翻译（429→RateLimited、401/403→MissingCredential） | `DeepSeekAdapter.SendAsync` | `Di.Tests/Providers/DeepSeekAuthTests.cs` 等 |
| 线格式翻译（5 条怪癖） | `DeepSeekTranslator` | `Di.Tests/Providers/DeepSeekTranslatorTests.cs` |
| 前缀缓存优化（请求布局 / 可空集合 / 快照 append-on-change） | `DeepSeekTranslator` + `AgentRunner` | `Di.Tests/Providers/DeepSeekUsageParsingTests.cs` |
| 模型目录（2 模型 + 费率，⚠ 费率占位需核对） | `DeepSeekAdapter.Catalog` | `Di.Tests/Llm/ModelCatalogTests.cs` |
| 请求时鉴权（config 优先、env 兜底） | `DeepSeekAdapter.ResolveApiKeyAsync` | `Di.Tests/Providers/DeepSeekAuthTests.cs` |
| 响应标识上报 | `DeepSeekAdapter.StreamAsync` | `Di.Tests/Providers/*` |
| 端到端（真实 API，`SkippableFact`，无 key 自动跳过） | `DeepSeekReActIntegrationTests` | `Di.Tests/Integration/DeepSeekReActIntegrationTests.cs` |

## 关联文档

- `docs/modules/llm.md` —— 适配器抽象侧（`StreamChunk` 协议义务 / `Auth` / `Catalog`）
- `docs/roadmap.md` —— 第二 provider（验证厂商无关性的最强测试，Phase D）
