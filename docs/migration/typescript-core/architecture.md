# TypeScript Core 迁移架构

本文是 Di Core 首期 TypeScript 迁移的实现契约，供后续执行代理按阶段逐项落地。基线是 Di `09f4e0816c1b2dc42461e79a968b46e811d3880c`；参考 Pi 固定提交 [`7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333`](https://github.com/earendil-works/pi/tree/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333)。本文件描述的 `packages/` 路径均为未来规划，不代表当前 Di 已有这些源码。

## 首期边界与包职责

首期把 Core 与 Node 宿主迁入 TypeScript，并复用 `tui/` 作为渲染库。未来生产入口唯一归 `@di/coding-agent`：`di-ts` 指向 `packages/coding-agent/dist/cli/main.js`；coding-agent 组合 provider/config/session/tools 后，interactive 模式建立 local adapter 并调用 `di-tui` 导出的 `runInteractive(port)`。`di-tui` 不依赖 coding-agent，避免循环依赖。现有 `tui/src/main.ts` 可继续独立启动旧 RPC client，用于 C# 兼容和协议测试；旧 C# 源码与界面在验证迁移完成前并存。

| 规划包 | 允许职责 | 明确不做 |
|---|---|---|
| `packages/ai` (`@di/ai`) | 提供商无关的消息、内容块、工具 schema、模型引用、流式 chunk、usage / finish reason / failure 类型；流式模型接口；provider 接口和 DeepSeek、ChatGPT 适配器 | 会话历史管理、工具执行、文件系统、CLI、UI、Di 会话 JSONL |
| `packages/agent` (`@di/agent`) | 纯 ReAct 循环；注入式模型流、工具执行与校验接口；loop 事件和结果；循环阶段上的中断及请求 token 上限守卫 | Node API、文件系统、子进程、具体工具 / skills / session store / UI / JSON 协议 |
| `packages/coding-agent` (`@di/coding-agent`) | Node 宿主组合根；`src/core` 中 `AgentSession`、内建工具、skills、session/config/auth storage、budget 与日志；`src/modes` 中 print/json/rpc；暴露稳定的 runner 接口给 TUI adapter | AI 消息词汇和提供商协议的第二份定义；UI 组件 |
| `tui/`（保留，未来 package `di-tui`） | 导出 `RunnerPort` wire-shape contract 和 `runInteractive(port)`；保留旧 RPC launcher；render-only app | 运行时导入 coding-agent、agent 或 ai；拥有生产 bin / Core 组合根 |

依赖必须单向：`@di/agent → @di/ai`；`@di/coding-agent → @di/agent + @di/ai + di-tui`；`di-tui` 不依赖 coding-agent。交互时由 coding-agent 依赖注入：调用方向为 `coding-agent CLI → LocalAgentRunnerAdapter → CoreRunner`，并把实现了 `di-tui.RunnerPort` 的 adapter 传给 `di-tui.runInteractive`。`tui/src/main.ts` 只作旧 RPC launcher，不是 coding-agent 的 import 入口。`ai` 和 `agent` 不访问 Node IO；只有 coding-agent/TUI 宿主可引用 `node:fs`、`node:child_process`、路径、家目录和终端。首期不拆 protocol/runtime 包；RPC 编解码留在 `packages/coding-agent/src/modes/rpc`，TUI wire shape 留在 `tui/src/rpc/protocol.ts`。

## Di 当前模块到规划路径

左侧是基线中已核实的仓库相对路径和关键符号；右侧为迁移目标路径，均是规划路径。不得把右侧当作现存源码引用。

| 当前实现（Di 基线） | 未来实现（规划路径） | 迁移边界 |
|---|---|---|
| `Core/Llm/ChatMessage.cs` (`ChatMessage`, concrete message records), `Core/Llm/ContentBlock.cs`, `Core/Llm/FinishReason.cs`, `Core/Llm/TokenUsage.cs`, `Core/Llm/ModelOptions.cs`, `Core/Llm/ModelReference.cs` | `packages/ai/src/types/messages.ts`, `content.ts`, `stream.ts`, `model.ts` | 仅转成 TS union / interfaces；JSON provider DTO 不泄漏进统一词汇 |
| `Core/Llm/IChatModel.cs`, `Core/Llm/ChatModelClient.cs`, `Core/Llm/RetryingChatModel.cs`, `Core/Llm/ChatAssembler.cs`, `Core/Llm/TokenEstimator.cs`, `Core/Llm/CostAccounting.cs`, `Core/Llm/LlmException.cs` | `packages/ai/src/model.ts`, `stream-assembler.ts`, `retry.ts`, `usage.ts`, `errors.ts` | 模型一次请求与 stream 组装 / 重试 / 计量属于 AI 包；把配置或 IO 注入，不读取 `~/.di` |
| `Core/Providers/DeepSeek/DeepSeekAdapter.cs`, `Core/Providers/DeepSeek/DeepSeekTranslator.cs`, `Core/Providers/DeepSeek/DeepSeekChatRequest.cs`, `Core/Providers/DeepSeek/DeepSeekChatResponse.cs` | `packages/ai/src/providers/deepseek/` | 保留 provider wire DTO、SSE 解析与怪癖翻译在 adapter 内 |
| `Core/Providers/ChatGpt/ChatGptAdapter.cs`, `Core/Providers/ChatGpt/ChatGptTranslator.cs`, `Core/Providers/ChatGpt/ChatGptAuth.cs`, `Core/Providers/ChatGpt/ChatGptCredentialStore.cs` | adapter -> `packages/ai/src/providers/chatgpt/`；凭据存取 -> `packages/coding-agent/src/core/auth/` | AI 适配器只收到宿主解析好的凭据；刷新 / 保存凭据由 Node 宿主负责 |
| `Core/AgentLoop/ReAct.cs`, `Core/AgentLoop/AgentRequest.cs`, `Core/AgentLoop/AgentResult.cs`, `Core/AgentLoop/AgentLoopOptions.cs`, `Core/AgentLoop/IToolExecutor.cs`, `Core/AgentLoop/IToolValidator.cs`, `Core/AgentLoop/IInterruptSignal.cs` | `packages/agent/src/agent-loop.ts`, `types.ts`, `tools.ts`, `interrupt.ts` | 只迁循环控制、工具调用抽象、结束原因；TS `AbortSignal` 负责硬取消，额外 stop predicate 保留相位边界软停止 |
| `Core/AgentLoop/AgentRunner.cs`, `Core/AgentLoop/IAgentRunner.cs`, `Core/AgentLoop/EnvironmentSnapshot.cs` | `packages/coding-agent/src/core/agent-session.ts`, `agent-runner.ts`, `environment-snapshot.ts` | 历史累加、模型选择、预算、skill 上下文、checkpoint、恢复和目录快照都是宿主逻辑 |
| `Core/AgentLoop/AgentLoopEvent.cs`, `Core/AgentLoop/RunEvents.cs`; `Common/Events/` | loop 内 `packages/agent/src/events.ts`；宿主日志钩子在 `packages/coding-agent/src/core/events.ts` | 传输事件使用 async event sink；避免把 .NET EventBus 的 push+pull 多态实现照搬进 JS |
| `Core/Tools/` (`CoreTools`, `ICoreTool`, 8 个内建工具及 process helpers) | `packages/coding-agent/src/core/tools/` | 所有 Node fs/process 能力只从 coding-agent 进入；tool schema 随工具实现共置 |
| `Core/Skills/SkillRepository.cs`, `Core/Skills/SkillMarkdown.cs`, `Core/Skills/SkillMatcher.cs`, `Core/Skills/SkillActivation.cs`, `Core/Skills/SkillTools.cs` | `packages/coding-agent/src/core/skills/` | fs 扫描、Markdown 读取和 load_skill 执行是宿主责任；可纯测的解析 / 匹配仍置于同目录但避免 Node IO |
| `Core/Sessions/SessionLog.cs`, `Core/Sessions/SessionRecovery.cs`, `Core/Sessions/SessionStats.cs` | `packages/coding-agent/src/core/sessions/` | JSONL 读写、recovery fail-closed、同步 checkpoint 写入都由 Node 宿主实现；持久化 schema 兼容基线 |
| `Core/ContextManagement/` (`BudgetPolicy`, `InputBudgetTracker`, `CompactingExecutor`, `ArtifactStore`) | `packages/coding-agent/src/core/context/` | 预算估算和工具输出 spill 属宿主层（含 artifact fs）；不得宣称 token estimate 等于 provider 精确计数 |
| `Core/Logging/DiLog.cs`; `Core/Configuration/DiHome.cs` | `packages/coding-agent/src/core/logging/`, `config/` | 运行日志、分层配置和家目录解析皆宿主 IO；配置现状与兼容要求参见 execution plan |
| `Di.Cli/modes/PrintMode.cs`, `Di.Cli/modes/RpcMode.cs`, `Di.Cli/CliHost.cs`; `tui/src/rpc/`, `tui/src/main.ts` | `packages/coding-agent/src/modes/{print,json,rpc}/`；`tui/src/runner/port.ts`, `tui/src/interactive.ts`, `tui/src/index.ts`；`packages/coding-agent/src/adapters/tui-runner.ts` | 先保持 RPC 入出线格式和现有 TUI wire view model，再由生产 CLI 把本地 adapter 注入 TUI |
| `Di.Cli/Commands/` (`SlashCommandRegistry`, `BuiltinCommands`, `CommandLoader`, `CommandMarkdown`), `Di.Cli/ModelSelection.cs`, `Di.Cli/cli/CliArgs.cs` | `packages/coding-agent/src/core/commands/`, `src/core/model-selection.ts`, `src/cli/` | 用户命令/斜杠命令、模型选择及参数解析按 execution plan 的 owned outputs 迁移；此处只维护来源映射 |

完整阶段列表和 skills/config/logging/命令迁移清单由 [execution plan](execution-plan.md) 维护；循环与历史具体契约见 [loop and state](loop-and-state.md)。

## Runner seam 与 TUI 复用

分开定义核心 runner 和 TUI 兼容 facade。公共 Core API 使用 camelCase typed union；TUI 当前 `TurnStateMachine`、view 与 `tui/src/rpc/protocol.ts` 使用 wire 形状（`kind: "text_delta"`、`is_error`、`stop_reason`），首期保留其状态机与渲染逻辑。`RunnerPort` / `runInteractive(port)` 由未来 `tui/src/runner/` 和 `tui/src/interactive.ts` 导出。coding-agent 的 `LocalAgentRunnerAdapter` 放在 `packages/coding-agent/src/adapters/tui-runner.ts`，把 `AgentEvent` / `AgentResult` 显式转换成现有 protocol.ts 事件 / 结果；adapter 使用 TUI 的 wire-shape 类型，Core 内部不可依赖这些类型。RPC client 仍解析 NDJSON 并产出相同 wire union。未来 UI 若单独迁 camelCase，再改 adapter 与状态机，不能把该改造夹在 Core 迁移中。

以下是接口草图，不是自包含的可复制源码；类型须按下表从所属包公共入口导入。Core 的宿主 API 表达单次 session 能力，不包含子进程与 wire DTO：

```ts
export interface CoreRunner {
  runTurn(input: RunTurnInput, signal?: AbortSignal): Promise<AgentResult>;
  requestSoftStop(): void; // 仅 phase-boundary graceful stop
  resetHistory(): void;
  setModel(model: ModelRef): Promise<void>;
  setSkills(names: readonly string[]): void;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}

export interface RunTurnInput { message: string }
```

| 契约名 | 唯一定义 owner / 未来位置 | 依赖关系 |
|---|---|---|
| `ModelRef`, `AgentMessage`, `ToolCall`, `ToolResultMessage`, `ToolSpec`, `TokenUsage`, `UsageCost`, `FinishReason`, `LlmFailure`, `ModelRequest`, `ModelResponse`, `ModelEvent`, `ChatModel` | `@di/ai`：`packages/ai/src/types/messages.ts`, `tools.ts`, `stream.ts`、`model.ts` | 不依赖 agent 或 Node；`ToolSpec` 是模型工具词汇，`ModelRequest.tools` 为 `readonly ToolSpec[]`；`ToolResultMessage` 属于 AI message union |
| `AgentRequest`, `AgentDependencies`, `AgentEvent`, `AgentResult`, `StopReason`, `ToolObservation`, `ToolExecutor`, `ToolValidator`, `LoopCheckpoint`, `runAgentLoop` | `@di/agent`：`packages/agent/src/types.ts`、`tools.ts`、`agent-loop.ts` | 仅导入 `@di/ai` 词汇与 Web API types |
| `AgentSession`, `CoreRunner`, `RunTurnInput`, `LocalAgentRunnerAdapter` | `@di/coding-agent`：`packages/coding-agent/src/core/agent-session.ts`、`src/adapters/tui-runner.ts` | `CoreRunner.runTurn` 返回 `@di/agent` 的 `AgentResult`；adapter 转成下列 TUI wire result |
| `RunnerPort`, `RunnerPortHandlers`, `runInteractive`, `Rpc*` wire aliases | `di-tui`：未来 `tui/src/runner/port.ts`、`tui/src/interactive.ts`；wire source 为现存 `tui/src/rpc/protocol.ts` | TUI 不导入 `@di/agent` / coding-agent；`RpcAgentResult` 是 protocol result，不能与 Core `AgentResult` 混用 |

因此上方 CoreRunner 草图中的返回类型应读作 `AgentResult`（来自 `@di/agent`），而 RunnerPort 的返回类型是 protocol wire 的 `RpcAgentResult`。adapter 是两者之间唯一转换点。

以下代码块是跨包契约草图，不是可直接复制编译的完整实现。正式类型定义由各自 owner 阶段创建，并从包公共入口导出；当前现存 wire 类型定义在 `tui/src/rpc/protocol.ts`。TUI 依赖一个 `RunnerPort`，方法覆盖 `tui/src/rpc/client.ts` 的可见操作；callback payload 沿用 protocol.ts 的 `ReadyMessage`、`AgentEvent`、`AgentResult`、`CommandDescriptor`：

```ts
import type {
  AgentEvent as RpcAgentEvent,
  AgentResult as RpcAgentResult,
  CommandDescriptor as RpcCommandDescriptor,
  ModelInfo,
  ReadyMessage as RpcReadyMessage,
} from "../rpc/protocol.ts";

export interface RunnerPort { // 由 di-tui 导出；coding-agent 提供实现
  subscribe(handlers: RunnerPortHandlers): () => void;
  connect(): Promise<void>; // resolve 之前 onReady(meta: RpcReadyMessage) 必须执行一次
  prompt(message: string): Promise<RpcAgentResult>;
  interrupt(): void; // hard cancel，保持 TUI 当前首按 Ctrl+C 行为
  clearHistory(): void;
  setModel(model: string): void;
  setSkills(names: string[]): void;
  listCommands(): Promise<RpcCommandDescriptor[]>;
  runCommand(name: string, args?: string): Promise<{
    lines: string[]; exit: boolean; model?: string; effort?: string | null; models?: ModelInfo[];
  }>;
  ping(): void;
  stop(): Promise<void>; // graceful shutdown
}

export interface RunnerPortHandlers {
  onReady(meta: RpcReadyMessage): void;
  onEvent(event: RpcAgentEvent): void;
  onResult(result: RpcAgentResult): void;
  onError(message: string, code: string): void;
  onExit?(code: number | null, signal: NodeJS.Signals | null): void;
  onStderr?(chunk: string): void;
  onMalformed?(line: string, error: Error): void;
}
```

类型别名直接对应 `tui/src/rpc/protocol.ts` 中真实导出的 `AgentEvent`、`AgentResult`、`CommandDescriptor`、`ModelInfo`、`ReadyMessage`；这些是 `di-tui` 的公开 wire contract，不另造 schema。`NodeJS.Signals` 来自 TUI 已有 Node 类型依赖，Core 包不得引用它。各契约的唯一 owner、位置和依赖方向见上表；本处不提供第二套字段定义。coding-agent adapter 从 `CoreRunner.subscribe` 映射 camelCase events 为 protocol.ts 的 wire union，并转换结果和 ready metadata；ready 元数据含当前 model、effort、skills、models。`prompt` 绑定一个 AbortController 到 `CoreRunner.runTurn`；TUI `interrupt()` 调用 controller.abort()，将 hard abort 映射成当前 wire `stop_reason: "cancelled"`。不得把该方法直接连到 `CoreRunner.requestSoftStop()`。若后续交互希望 Ctrl+C 做软停，须单独改 UX 与协议语义，并新增测试。`CoreRunner.requestSoftStop()` 供可选择软停的其它宿主使用，回 `interrupted`。

### RunnerPort 生命周期与接线顺序

`runInteractive(port)` 负责 TUI 生命周期，调用者只提供已构造的 port。必须按以下顺序接线，避免错过 ready 或首个事件：

1. 创建 terminal、`TurnStateMachine`、view 与键盘回调；把所有 port handlers 注册到 `port.subscribe(handlers)`，保存返回的 unsubscribe。
2. 调用并等待 `port.connect()`。`connect()` 只在 `onReady(meta)` 已调用一次后 resolve；连接失败走现有 `onError`/退出路径，不进入可输入状态。
3. `RpcClientPort.subscribe` 在 connect 前缓存 handlers；`connect` 创建/启动底层 `RpcClient` 时将这些 handlers 绑定到 `RpcClientOptions`，ready callback 原样调用 `onReady` 后让 connect resolve。`LocalAgentRunnerAdapter.subscribe` 在内存注册 handlers；其 connect 从已组合的 session 生成等价 `ReadyMessage`，调用 `onReady` 后 resolve。两种实现都不得在订阅前发 ready/event。
4. `prompt` 时先由 port 建立本 turn 的完成等待，再启动 `CoreRunner.runTurn`；adapter 将同步/异步事件按序发给已订阅者，完成时调用一次 `onResult`，同时让 `prompt()` promise resolve 为同一个 result（调用方不可对 promise 再次更新 UI 状态）；失败时按现有错误约定 reject promise，session 级错误走 `onError`。`interrupt` 可在该等待期间触发硬取消。
5. `runInteractive` 在退出 `finally` 中先停止接收键盘输入，再 `await port.stop()`，随后 unsubscribe 并释放 view/terminal；`stop` 必须幂等。若 connect 未成功，仍执行 unsubscribe 和本地资源释放。

此顺序要求 terminal/view 构建与订阅发生在 connect 前。改造旧 `tui/src/main.ts` 时，应把现有 `RpcClient` callback 初始化移动到 `RpcClientPort.connect()`，不能在 `runInteractive` 开始后临时订阅。

RunnerPort 必须覆盖现有操作：`connect`/ready meta；`prompt` → 一次 turn events + result；`interrupt` → 当前硬取消；`clearHistory` → reset；`setModel`/`setSkills` → 更新 session；`listCommands` → `command {list:true}` 形状的命令描述；`runCommand` → 命令行、exit、模型状态快照与 turn-not-supported 错误；`ping` → no-op heartbeat；`stop` → graceful teardown。Local adapter 从 Node 组合根注入 `CommandRegistry` / host callbacks，不把命令注册或 protocol JSON 放进 `@di/agent`。

## 生产入口、包导出与依赖方向

生产部署只启动 `@di/coding-agent`，不单独启动 TUI 子进程：

```text
di-ts [--mode interactive|print|json|rpc] [CLI args]
  └─ packages/coding-agent/dist/cli/main.js       # 唯一生产 CLI/bin
       ├─ host composition: config/auth/models/tools/skills/session/commands
       ├─ CliMode.Resolve → interactive: CoreRunner + LocalAgentRunnerAdapter
       │                                  └─ di-tui.runInteractive(RunnerPort)
       ├─ --mode print/json: Node headless modes → same CoreRunner
       └─ --mode rpc: old NDJSON wire codec → same CoreRunner

tui/src/main.ts → legacy standalone RPC launcher → di --mode rpc (旧 C# 兼容 / 协议测试)
```

未来导出和入口约束（表中 `types` 指向同一构建产物的 `.d.ts`；生成声明前不得运行跨包 typecheck/test）：

| 包 | 导出 / bin | 说明 |
|---|---|---|
| `di-tui`（当前 `tui/` workspace，保留包名） | `package.json.exports["."]` 的 `types` / `import` 指向 `dist/index.d.ts` / `.js`；`exports["./protocol"]` 同理指向 `dist/rpc/protocol.d.ts` / `.js`；`index.ts` 导出 `runInteractive`、`RunnerPort` 与 handlers | render-only library；依赖 `@earendil-works/pi-tui`，不依赖 Core/coding-agent；`src/main.ts` 只用于旧 RPC launcher |
| `@di/coding-agent`（未来 `packages/coding-agent/`） | `bin.di-ts → ./dist/cli/main.js`；`exports["."]` 与 `exports["./cli"]` 同时含 `types` / `import` 映射到 `.d.ts` / `.js` | CLI 是唯一生产组合根。workspace dependency 指向 `di-tui`；coding-agent adapter 实现 `RunnerPort`，调用其 `runInteractive` |
| `@di/agent`, `@di/ai` | 各自 `exports["."]` 同时含 `types` / `import` 映射到 `dist/index.d.ts` / `.js` | library-only，不声明 CLI/bin |

`di-ts` 通过 execution plan 中的 `CliMode.Resolve` 继承现有优先级，不把缺省 interactive 提前于位置参数：显式 mode 优先，位置参数 / `--print` / 非 TTY 走 print，只有双 TTY 且未显式选择 headless mode 才进 interactive；`--resume` 无显式模式和 prompt 时进入简单交互并跳过 TUI，详见 execution plan。`print`、`json`、`rpc` 不额外启动 renderer，也不新建另一套 session core。`--mode rpc` 保持既有 NDJSON 协议，内部依旧调用同一 CoreRunner。根 workspace 的构建必须先按 `@di/ai` → `@di/agent` → `di-tui` → `@di/coding-agent` 生成依赖的 JS 与 `.d.ts`，再运行跨包测试/typecheck；各包测试可以在 build 后按 package 顺序运行，不要让测试依赖尚不存在的 `dist`。workspace TS 约定 `declaration: true` 和对应 `exports` 的 `types` 映射；现存 `tui/tsconfig.json` 为 `declaration:false`，TUI 接入 workspace 时须按此约定调整。`@di/ai` / `@di/agent` 是 library-only，不设 `start`；只有 `di-tui`（兼容旧 launcher）及 coding-agent CLI 需要可运行入口。命令清单在 [execution plan](execution-plan.md)。

由于 `@di/coding-agent` 在运行时导入 `di-tui`，安装包验证时不得留下无法解析的 workspace-only 依赖或指向 private 包。迁移验收先在本地生成 tarball 并在隔离临时项目安装验证依赖解析、入口与类型声明；本地 tarball/隔离安装验证不等同公开发布。不要因规划文档自动执行 npm publish：公开注册表发布仅在已有明确发布授权与包名所有权证据时才可进行；缺少任一项就不发布，但不影响本地迁移验收。`di-tui` 当前是未 scoped 名称，不得假设该名称可由本项目占有。根 workspaces 安装和本地脚本命令必须使用 npm 实际支持的 workspace dependency specifier，不盲写其他 package manager 的协议。

迁移顺序仍先 RPC 再 local adapter：P7 让现有 `tui/src/main.ts` 用旧 `RpcClient` 启动 `di-ts --mode rpc`，P9 才开放生产 CLI 的 local interactive 接线。只接线 TUI shell 边界：把当前 `tui/src/main.ts` 中“创建 terminal / state / ChatView / 输入键盘 / stop 生命周期”提取到 `tui/src/interactive.ts` 的 `runInteractive(port, options?)`；`tui/src/index.ts` 公开它和 `RunnerPort`。`tui/src/runner/rpc-port.ts` 提供 `RpcClientPort`：持有原 `tui/src/rpc/client.ts` 的 `RpcClient`，将 `RunnerPort.subscribe(handlers)` 映射到现有 `RpcClientOptions` callbacks；`tui/src/main.ts` 留下 `resolveDiBin`、创建 `RpcClientPort`、调用 `runInteractive(rpcPort)`。coding-agent 的 `src/cli/main.ts` 解析 args、构建 host、按 Resolve 结果选 mode；interactive 时创建 `CoreRunner` 和 `LocalAgentRunnerAdapter`，再传到 `runInteractive`。不改 `tui/src/app/state.ts` / `chat-view.ts` 的 wire types 和渲染状态机。这样依赖图固定为 coding-agent → di-tui，di-tui → coding-agent 不存在。

当前 `Di.Cli/modes/RpcMode.cs` 对忙时收到的 `prompt` 会先等待上一轮完成，再处理该行；这也会暂时阻塞 stdin 上后续 interrupt。TS RPC 首期明确选择：若 turn 正在执行，立即发 `error {code:"busy"}` 拒绝新 prompt，并继续读取 stdin，使 interrupt / shutdown 不被挂起；TUI 正常交互本来会在 busy 时阻止 Enter，故这一行为变化只影响并发/异常客户端，应记录在迁移兼容文档和 contract test。不要在同 session 并发运行两轮或默默以新 prompt 替代旧 turn。

外部 `--mode rpc` 保留 `docs/tui-rpc.md` 已有 request methods、正常响应消息形状、字段命名、seq 语义及既有 stop reason 名称。新增内部事件不得默认扩展线协议；未知旧协议 event 仍按 TUI 当前兼容策略处理。`tui/`、`tui/src/rpc/` 均为现存路径；本节提及的 `tui/src/runner/`、`tui/src/interactive.ts`、`tui/src/index.ts` 和 `packages/coding-agent/src/adapters/` 都是规划目标路径。

## AI Provider 流与模型事件分层

以下也是接口草图，类型的正式定义与导出任务属于 `@di/ai` 的模型类型/stream 实现阶段；不要作为一段自包含源码直接粘贴。provider 层不直接输出 loop 事件。低层 `ProviderChunk` 描述一次 provider 流的 block 生命周期、原始增量和 usage/finish；assembler 按 block index 组装为内部消息，`ChatModel.stream` 向 agent loop 输出高层 `ModelEvent`：

```ts
type ProviderChunk =
  | { type: "blockStart"; index: number; block: ProviderBlockStart }
  | { type: "textDelta"; index: number; delta: string }
  | { type: "reasoningDelta"; index: number; delta: string }
  | { type: "toolCallDelta"; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: "blockEnd"; index: number }
  | { type: "usage"; usage: TokenUsage }
  | { type: "finish"; reason: FinishReason };

type ModelEvent =
  | { type: "textDelta"; delta: string }
  | { type: "reasoningDelta"; delta: string }
  | { type: "toolCallDelta"; id: string; name: string; arguments: string }
  | { type: "completed"; response: ModelResponse };

interface ToolSpec {
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>; // JSON Schema object payload
  strict?: boolean;
}

interface ModelRequest {
  messages: readonly AgentMessage[];
  tools?: readonly ToolSpec[];
  maxTokens?: number;
  reasoningEffort?: string;
  // Other preserved C# request options are specified in models-and-auth.md.
}

interface ChatModel {
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}
```

名称只作本迁移接口草案，但两层边界固定：provider 的 `blockStart/blockEnd/usage/finish` 不向 `@di/agent` 泄漏；正式类型所有者为 `@di/ai`：`ProviderChunk`、`ProviderBlockStart`、`TokenUsage`、`FinishReason`、`ModelRequest`、`ModelResponse`、`ModelEvent`、`ChatModel`。这些类型从 `@di/ai` 公共入口导出，逐项实现在模型类型/stream assembler 单元。assembler 最终恰好产出一条 `completed`，其中 `ModelResponse` 是本次调用的完整 assistant message、usage、可得时 cost、finish reason 和 request metadata。usage/cost 是本次模型调用值；loop 对每个 completed 累加，并在 `turnCompleted` 事件/result 给出回合累计值。provider wire DTO/SSE 留在 `@di/ai` adapters。无 Node runtime 的 `@di/ai` / `@di/agent` 使用 `AbortSignal`、`TextEncoder` 等 Web API 类型时，workspace `tsconfig` 明确包含 `ES2022`, `DOM`, `DOM.Iterable` libs；网络访问通过注入的 fetch 函数，不直接读 Node globals。宿主可以注入 `globalThis.fetch`。

## TypeScript 与包约束

- 继续使用 `node:test` 与当前 TUI 测试风格；Node engine 最低 `>=22.19`。本机 Node 是 `24.16.0`，Di 当前 `tui/package-lock.json` 锁定 `typescript 5.9.3`、`@types/node 22.20.5` 和 `@earendil-works/pi-tui 1.2.0`；迁移首期 workspace 继续固定这些版本，不把工具链升级混入迁移。
- ESM、`strict`、`noUncheckedIndexedAccess`、erasable syntax，风格对齐当前 `tui/tsconfig.json`；不使用 TS enum、parameter properties、decorator metadata 依赖。
- JSON 输入视为 `unknown` 并在 RPC / provider 边界验证。只在验证后转成内部 union。provider wire types、RPC wire types 和持久化 JSONL payloads 各自隔离。
- `packages/ai` 和 `packages/agent` 的公开接口不要依赖 Node global IO；Node 类型只出现在 coding-agent 与 TUI。
- 所有关键异步操作接收 `AbortSignal`，不可吞掉调用者的 signal；工具收到同一当前 turn signal。软停止是不同于 abort 的正常结果。

## Pi 只读参考位置

以下 Pi 路径均位于本地只读参考 checkout `E:\Agent\PI\pi`，不属于 Di，也未在本轮运行安装、构建或测试。链接固定到上述提交，可独立审阅：

| 本地 Pi 根相对路径 | 关键结构 | 固定提交文件链接 |
|---|---|---|
| `packages/agent/README.md`, `packages/agent/src/types.ts`, `packages/agent/src/agent-loop.ts`, `packages/agent/src/agent.ts` | 纯循环 `runAgentLoop` 与有状态 `Agent` 分离；stream function / tool hooks / `AbortSignal` 注入 | [`agent` package](https://github.com/earendil-works/pi/tree/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/agent), [`agent-loop.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/agent/src/agent-loop.ts), [`agent.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/agent/src/agent.ts) |
| `packages/ai/README.md`, `packages/ai/src/` | provider-neutral model/message types 与厂商 adapters 分层 | [`ai` package](https://github.com/earendil-works/pi/tree/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/ai) |
| `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/README.md` | `AgentSession` 将 agent 状态、会话和 host 生命周期结合 | [`agent-session.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/src/core/agent-session.ts), [`coding-agent` package](https://github.com/earendil-works/pi/tree/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent) |

借鉴边界是“纯 loop + 状态 facade + coding host”，而非照搬 Pi 的扩展系统、消息定制机制、队列策略或 feature set。Di 的上下文暂停、Checkpoint 和旧 RPC 兼容按下文和 Di 契约实现。
