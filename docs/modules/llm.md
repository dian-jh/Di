# Core.Llm —— 模型层（厂商无关的抽象与装配）

> 模块文档。回答"模型层如何做到厂商无关、流式协议义务是什么、重试 / 计量 / 成本 / 目录 / 认证怎么工作"。
> 上一级入口：`docs/README.md`；具体厂商实现见 `docs/modules/deepseek.md`。

## 目的与职责

模型层的**抽象与装配**：适配器注册 / 路由、流式协议、重试、消息词汇、token 计量、成本核算、
模型目录、认证声明。核心思想——**一切厂商怪癖收敛在适配器翻译层、模型是纯数据、认证是声明**。

## 实现原理

### 适配器抽象（`Core/Llm/ChatAdapter.cs`）

- `ChatAdapter` 抽象类，**唯一抽象成员 `StreamAsync`**（产 `StreamChunk` 流）；其余能力是数据：
  - `ProviderIds`：适配器声明的 provider 名列表（路由键）；
  - `Catalog`（`IReadOnlyList<ModelSpec>`）：模型目录，`ListModels` / `ResolveModelAsync` /
    `CalculateCost` 全部从目录派生，加模型 = 目录加一条，引擎零改动；
  - `Auth`（`LlmAuthDefinition`）：鉴权声明即数据，凭据请求时解析（config > env）。

### 路由与请求分发（`Core/Llm/LlmRuntime.cs` / `ILlmService`）

- 适配器按 `ProviderIds` 装入路由表；`RegisterAdapter` 返回 `IAdapterRegistration` 句柄，
  可原子替换 / 撤销路由（`AdaptersUpdated` 事件）。注册 / 替换 / 撤销共用写锁，
  读者读取不可变路由快照；冲突不会留下部分注册，同一适配器的不同句柄各自拥有路由，
  调用方修改传入数组不影响句柄所有权。事件在发布快照并释放写锁后通知。
- `StreamAsync` 前置校验：模型是否支持所请求的推理强度（不支持抛 `UNSUPPORTED_OPTION`）。
- **请求时鉴权**：适配器声明 `Auth` 后先解析凭据（config > env），缺 key 抛 `MISSING_CREDENTIAL`——
  DI 注册不再要求 key，CLI 无 key 也能启动。

### 流式协议义务（`Core/Llm/StreamChunk.cs`）

- `StreamChunk` 是适配器 → 装配层的最小流单元：`BlockStart` / `TextDelta` / `ReasoningDelta` /
  `ToolCallDelta` / `BlockEnd` / `ResponseInfo` / `Usage` / `Finish`。
- 协议义务：**Usage 必须在 Finish 之前**；Finish 后不得再有块；工具参数全程原始 JSON 字符串；
  错误只有"抛 `LlmException`（传输 / 协议）"或"`Finish(Error/Aborted)`（带内）"两条合法路径。
- `ChatModelClient.StreamAsync` 防御性截断：Finish 后拒绝后续 chunk（防坏适配器）。

### 装配与装饰（`ChatModelClient` / `RetryingChatModel` / `ChatAssembler`）

- `ChatModelClient`：`IChatModel` 标准实现，`ModelRequest` → `GenerateOptions` → 消费流；
  `ModelResponse` 携带 `cost`（按目录费率折算）、`responseId`、`timestamp`、`durationMs`。
- `RetryingChatModel`（装饰器）：对可重试故障（429 / 超时 / 连接 / 5xx）指数退避重试，
  尊重 `Retry-After` + ±20% 抖动；流式整体重枚举，对 ReAct 完全透明。
- `ChatAssembler`：把流式 chunk 按块 index 装配成 `AssistantMessage`（text / reasoning / tool-call）。

### 消息词汇与计量

- 消息词汇（`Core/Llm/ChatMessage.cs` / `Core/Llm/ContentBlock.cs`）：system / user / assistant / tool 消息；
  text / reasoning / image / file / tool-call / tool-result 块；`OpaqueBlock` 对未知块无损透传。
  **reasoning 是一等公民**——带 tools 时必须完整回放，否则 DeepSeek 400。
- `TokenUsage`：互斥计数（input = 未命中，缓存命中单独报 CacheRead / CacheWrite）；
  `Add` 用 `SumOrNull` 保留可空字段。
- `Core/Llm/CostAccounting.cs`：`UsageCost`（input / output / cache_read / cache_write + Total）+ `CostCalculator`
  按每百万 token 费率折算；目录无费率时成本为 null。

## 当前 TypeScript 代码入口

| 文件（仓库根相对路径） | 职责 |
|---|---|
| `packages/ai/src/types/` | provider-neutral messages / model / stream / tool schema types |
| `packages/ai/src/stream-assembler.ts` / `sse.ts` | stream block assembly and SSE framing |
| `packages/ai/src/retry/` | `RetryingChatModel` and retry policy |
| `packages/ai/src/catalog.ts` / `usage.ts` | model context/cost catalog and usage/cost accounting |
| `packages/ai/src/providers/deepseek/` / `providers/chatgpt/` | provider adapters and wire translation |
| `packages/coding-agent/src/cli/provider-runtime.ts` | default provider routing and retry wrappers |
| `packages/coding-agent/src/cli/cli-host-compose.ts` (`CatalogModelService`) | production model window/reasoning metadata and local auth checks |
| `packages/coding-agent/src/core/model-selection.ts` | advisory catalog selection, routing labels and reasoning effort |
| `packages/coding-agent/src/cli/cli-host-compose.ts` | production model service/factory seam and request-time provider configuration |
| `packages/ai/test/` | adapter, stream, retry, catalog and accounting tests |

## C# 基线代码入口（行为参考）

| 文件（相对仓库根） | 职责 |
|---|---|
| `Core/Llm/ChatAdapter.cs` | 适配器抽象（`StreamAsync` + `ProviderIds` / `Catalog` / `Auth` 数据） |
| `Core/Llm/ILlmService.cs` / `Core/Llm/LlmRuntime.cs` | 路由 / 请求分发 / 动态注册 |
| `Core/Llm/StreamChunk.cs` | 流式最小单元与协议义务 |
| `Core/Llm/IChatModel.cs` | `IChatModel` / `ModelRequest` / `ModelResponse` / `ModelEvent` |
| `Core/Llm/ChatModelClient.cs` | `IChatModel` 标准实现 |
| `Core/Llm/RetryingChatModel.cs` | 重试装饰器 + `RetryPolicyOptions` |
| `Core/Llm/ChatAssembler.cs` | 流式块装配 |
| `Core/Llm/ChatMessage.cs` / `Core/Llm/ContentBlock.cs` / `Core/Llm/ChatRole.cs` | 消息与内容块词汇 |
| `Core/Llm/TokenUsage.cs` | token 计量 |
| `Core/Llm/CostAccounting.cs` | `UsageCost` / `CostCalculator` |
| `Core/Llm/ModelCatalog.cs` | `ModelSpec` 目录记录（纯数据） |
| `Core/Llm/LlmAuth.cs` / `Core/Llm/ILlmCredentialStore.cs` | 认证声明（`ApiKey`）与凭据存储（`EnvironmentCredentialStore`） |
| `Core/Llm/LlmException.cs` | 结构化错误（稳定错误码 + `IsRetryable` + status） |
| `Core/Llm/GenerateOptions.cs` | 请求体（含 `ChatTool` schema / `ChatToolChoice` / 采样参数） |
| `Core/Llm/LlmMetadata.cs` | 元数据 record（模型信息 / 推理档位 / 解析结果） |
| `Core/Llm/FinishReason.cs` | `FinishReason`（Stop / ToolCalls / MaxTokens / Aborted / Error）+ `LlmFailure` |
| `Core/Llm/ModelOptions.cs` | 配置段绑定（`Provider` / `DefaultModel`） |
| `Core/Llm/LlmServiceCollectionExtensions.cs` | DI 注册扩展 |

## 关键符号

- `ChatAdapter`、`ILlmService` / `LlmRuntime` / `IAdapterRegistration`
- `IChatModel` / `ModelRequest` / `ModelResponse` / `ModelEvent`
- `StreamChunk`（及子 record）、`ChatAssembler`、`ChatModelClient`、`RetryingChatModel`
- `TokenUsage`、`UsageCost` / `CostCalculator`、`ModelSpec`
- `LlmAuthDefinition` / `ApiKey`、`ILlmCredentialStore` / `EnvironmentCredentialStore`
- `LlmException`、`FinishReason` / `LlmFailure`、`ChatTool` / `ChatToolChoice`

## 已实现能力与测试

| 能力 | 落点 | 测试 |
|---|---|---|
| Provider 路由（动态注册 / 替换） | `LlmRuntime` / `ChatAdapter.ProviderIds` | `Di.Tests/Llm/ModelCatalogTests.cs` 等 |
| 流式一等公民 + 协议义务 | `Core/Llm/StreamChunk.cs` | `Di.Tests/Llm/ChatModelClientTests.cs` |
| 流式装配 | `ChatAssembler` | `Di.Tests/Llm/ChatModelClientTests.cs` |
| 重试装饰器 | `RetryingChatModel` | `Di.Tests/Llm/RetryingChatModelTests.cs` |
| token 计量 | `TokenUsage` | 缓存命中 / 写入 / 推理 token 独立计数；`Add` 用 `SumOrNull` 保留可空字段，`Zero.Add(x)` 是恒等 | `Di.Tests/Llm/TokenUsageTests.cs` |
| 成本核算 | `Core/Llm/CostAccounting.cs` | `UsageCost` + `CostCalculator` 按每百万 token 费率折算；目录无费率时成本为 null | `Di.Tests/Llm/CostAccountingTests.cs` |
| 模型目录（模型即纯数据） | `Core/Llm/ModelCatalog.cs` / `ChatAdapter.Catalog` | `ListModels` / `ResolveModelAsync` / `CalculateCost` 全从目录派生；未知模型落缺省不抛 | `Di.Tests/Llm/ModelCatalogTests.cs` |
| 认证抽象（声明即数据，请求时解析） | `Core/Llm/LlmAuth.cs` / `Core/Llm/ILlmCredentialStore.cs` | 适配器声明 `Auth`（`ApiKey` record / `EnvApiKey` 便捷工厂），凭据请求时解析（config > env）；默认 `EnvironmentCredentialStore` 首个非空环境变量生效 | `Di.Tests/Llm/AuthTests.cs` |
| 响应元数据 | `Core/Llm/IChatModel.cs`（`ModelResponse`） | `Cost` / `ResponseId` / `Timestamp`（请求开始 Unix 毫秒）/ `DurationMs`（单调时钟） | `Di.Tests/Llm/ChatModelClientTests.cs` |
| 采样参数透传 | `Core/Llm/IChatModel.cs`（`ModelRequest`）/ `GenerateOptions` | temperature / top_p / frequency_penalty / presence_penalty，未设置保持 null 交适配器缺省 | `Di.Tests/Llm/ModelCatalogTests.cs` |
| 结构化错误 | `LlmException` | 稳定错误码 + `IsRetryable` + status + `Retry-After`；无裸异常 | `Di.Tests/Llm/ChatModelClientTests.cs` |
| Finish 后拒绝坏 chunk | `ChatModelClient.StreamAsync` | `Di.Tests/Llm/ChatModelClientTests.cs` |
| 消息词汇（reasoning 一等公民 / OpaqueBlock） | `Core/Llm/ChatMessage.cs` / `Core/Llm/ContentBlock.cs` | `Di.Tests/Llm/*` |

## 关联文档

- `docs/modules/deepseek.md` —— 唯一已实现的厂商适配器（厂商怪癖全部收敛在其翻译层）
- `docs/modules/agent-loop.md` —— 循环层如何使用 `IChatModel` / `ModelResponse`
- `docs/cli.md` —— 模型工厂组合（`RetryingChatModel(ChatModelClient(...))`）
