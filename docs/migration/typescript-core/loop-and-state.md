# Loop 与会话状态迁移

本文定义 Di ReAct 循环、Node 会话宿主、预算记忆和事件在 TypeScript 首期中的可执行语义。规划源码位置见 [迁移架构](architecture.md)；当前事实来自 `Core/AgentLoop/ReAct.cs`（`RunCoreAsync`、`EstimateRequestTokens`）、`Core/AgentLoop/AgentRunner.cs`（`RunAsync`、`TrimHistoryByTokens`、`SanitizeHistory`）、`Core/AgentLoop/AgentRequest.cs`、`Core/AgentLoop/AgentResult.cs`、`Core/AgentLoop/AgentLoopEvent.cs`、`Core/ContextManagement/BudgetPolicy.cs`、`Core/Sessions/SessionLog.cs`。这些 C# 文件是迁移基线，不是未来 TS 的模块目标。

## 所有权与接口草案

`@di/agent` 的循环每次运行只拥有本回合 trajectory、usage、cost、iteration 和 loop 控制；它不保存下轮历史，也不访问 Node。`@di/coding-agent` 的 `AgentSession` 持有跨回合历史、当前 model、skill 激活、budget tracker、session checkpoint / recovery 和 stop controller。调用图：

```text
CLI / RPC mode / LocalAgentRunnerAdapter
  └─ AgentSession.runTurn (唯一 session turn entry; 串行化同一 session)
       ├─ resolve model, active skills, environment snapshot, budget
       ├─ prepare loop input: stable system prompt + memory + user + volatile skill context + tools
       └─ runAgentLoop(request, dependencies, signal)
            ├─ build full ModelRequest each iteration → await model stream → await event sink
            ├─ checkpoint assistant/tool intent before side effect
            ├─ await toolExecutor.execute → append observation → checkpoint result
            └─ AgentResult
       ├─ update or preserve durable in-memory history
       └─ await terminal checkpoint marker; update tracker
```

`AgentRunner` 是当前 C# 的组装/策略事实，不在 TS 中再包一层可变 session facade；把相应职责并入 `AgentSession` 私有方法或纯 helper。`LocalAgentRunnerAdapter.prompt`、RPC mode 与 print/json mode 都调用同一个 `AgentSession.runTurn`，不得各自维护历史副本。

以下是跨包契约草图，不是可复制后即可编译的完整源码。未在此定义的 `AgentMessage`、`ToolResultMessage`、`ToolCall`、`ToolSpec`、`ModelRequest`、`ModelResponse`、`ModelEvent`、`ChatModel`、`TokenUsage`、`UsageCost`、`FinishReason`、`LlmFailure` 必须从 `@di/ai` 公共入口导入。`ModelRequest.tools` 使用 `readonly ToolSpec[]`；`ToolSpec` 只描述模型工具 schema，不含 executor/validator。具体归属和定义任务见 [迁移架构](architecture.md#ai-provider-流与模型事件分层)。正式实现时先完成并导出 AI 类型，再实现 loop。

建议公开的最小 loop types；下面的 `AgentRequest`、`AgentDependencies`、`AgentEvent`、`AgentResult`、`StopReason`、`ToolObservation`、`ToolExecutor`、`ToolValidator`、`LoopCheckpoint` 必须由 `packages/agent/src/types.ts` 或 `tools.ts` 定义，并从 `packages/agent/src/index.ts` 导出。`ToolResultMessage` 是 `@di/ai` 的 `AgentMessage` union 成员，只能在 `@di/ai` 定义并导出，以避免依赖反转。代码块仅画接口边界，省略 imports、错误类和 wire/JSON Schema runtime 验证实现：

```ts
export interface AgentRequest {
  sessionId: string;
  systemPrompt: string;
  userMessage: string;
  history: readonly AgentMessage[];
  systemContext?: string;
  tools: readonly ToolSpec[]; // import AI model-vocabulary type from @di/ai
  contextTokenBudget?: number; // 宿主给的估算 guard；不是供应商 tokenizer 的精确 token limit
  maxIterations?: number; // 缺省 0；0 = unlimited，正整数 = 最多模型调用次数
  maxTokens?: number; // 每次模型调用的最大输出 tokens；省略 = provider/model default
  reasoningEffort?: string; // opaque provider/model value; adapter validates support
  finalOutputTool?: string;
}

export type StopReason =
  | "answer" | "final_output_tool" | "max_iterations"
  | "error" | "interrupted" | "context_limit";

export interface ToolObservation {
  text: string;
  isError: boolean;
}

export type AgentEvent =
  | { type: "textDelta"; delta: string }
  | { type: "reasoningDelta"; delta: string }
  | { type: "toolCallDelta"; id: string; name: string; arguments: string }
  | { type: "turnCompleted"; iteration: number; usage: TokenUsage; cost?: UsageCost; finishReason: FinishReason }
  | { type: "toolStarted"; call: ToolCall }
  | { type: "toolCompleted"; call: ToolCall; observation: string; isError: boolean }
  | { type: "runFailed"; failure: LlmFailure }
  | { type: "interrupted" };

export interface AgentResult {
  answer: string;
  trajectory: readonly AgentMessage[];
  history: readonly AgentMessage[];
  usage: TokenUsage;
  cost?: UsageCost;
  iterations: number;
  stopReason: StopReason;
  failure?: LlmFailure;
}

export interface ToolExecutor {
  execute(call: ToolCall, signal?: AbortSignal): Promise<ToolObservation>;
}

export interface ToolValidator {
  validate(call: ToolCall, signal?: AbortSignal): void | Promise<void>;
}

export interface LoopCheckpoint {
  appendMessage(message: AgentMessage): void | Promise<void>;
  toolStarted(call: ToolCall): void | Promise<void>;
  toolCompleted(result: ToolResultMessage): void | Promise<void>;
}

export interface AgentDependencies {
  model: ChatModel;
  toolExecutor: ToolExecutor;
  estimateRequestTokens: (request: ModelRequest) => number; // pure or injected helper; never Node Buffer API
  toolValidator?: ToolValidator;
  events?: (event: AgentEvent) => void | Promise<void>; // observer only; exceptions isolated and diagnosed
  onObserverError?: (error: unknown, event: AgentEvent) => void | Promise<void>; // ordered diagnostic side channel; its own errors swallowed
  checkpoint?: LoopCheckpoint;
  interruptRequested?: () => boolean; // 软停止，在模型/工具相位尚未开始時检查
  beforeToolExecution?: (trajectory: readonly AgentMessage[]) => void | Promise<void>;
}

export function runAgentLoop(
  request: AgentRequest,
  dependencies: AgentDependencies,
  signal?: AbortSignal,
): Promise<AgentResult>;
```

`ToolSpec` 是 `@di/ai` 的模型词汇，`ModelRequest.tools` 为 `readonly ToolSpec[]`；TS 类型保留 `name`、`description`、`parameters` JSON Schema 对象和可选 `strict`，schema 内容作为 JSON 对象数据传递，首期不另建验证语言或执行字段。`ToolObservation` 是 `@di/agent` executor 结果（文本与 `isError`）；`ToolResultMessage` 是 `@di/ai` message union 中的工具结果成员，loop 仅构造该成员，不在 agent 包重定义消息词汇。正式实现时从 `@di/ai` 导入该 union 的 tool-result 成员，并用它定义 checkpoint 参数。

`AgentResult` 包含 `answer`、本回合完整 `trajectory`、原样传入且 loop 不修改的只读 `history`、累计 `usage`、可得时 `cost`、`iterations`、`stopReason` 和可选 `failure`。`stopReason` 延续 `answer | final_output_tool | max_iterations | error | interrupted | context_limit`；hard abort 通过 `AbortError` rejection 表达（RPC 宿主可映射成原 `cancelled` 结果）。不要把 canceled 与 phase-boundary `interrupted` 混为一个状态。

checkpoint 回调可以异步，但必须在副作用之前逐个 `await`：模型完整 assistant message 被接受后先 `await appendMessage`，才处理工具调用；执行工具前先 `await toolStarted(call)`，写入失败时工具绝不运行。工具完成后按 Di 当前顺序先发 `toolCompleted` 观测事件，再将观察加入 trajectory 并 `await toolCompleted(result)` 写 checkpoint；结果 checkpoint 完成后才准发起下一次模型请求。结果 checkpoint 失败时不启动下一次模型请求，并把已发生但未确认的副作用交 AgentSession recovery。checkpoint 的错误原样中止 loop。validator、预算更新和其他明确的 before-tool 控制 hook 异常也必须中止，不得越过授权 / 校验继续运行工具。

事件 sink 是观测旁路，不是控制面。为保事件顺序，可 await 每次 listener 返回的 Promise，但必须捕获 listener/UI/logging/telemetry 异常、按序 await 诊断回调，并继续循环；诊断回调自身同步抛错或 Promise rejection 都要 catch 并吞掉，不能形成未处理 rejection。观测故障不能阻止已经授权的工具执行，也不能将一个成功回合变成失败。不要因 sink 异步就将通知改成无序 fire-and-forget；await sink + catch 实现顺序与异常隔离。

## 一回合精确时序

`runAgentLoop` 执行如下顺序：

1. 检查 `signal.aborted`；检查软中断。合成本回合 trajectory：`history + userMessage`。不修改调用者的 history 数组。
2. 构建每次模型调用上下文：稳定 system prompt、history/当前 trajectory、可选 volatile `systemContext`、tool definitions；`ModelRequest.maxTokens` 与 `.reasoningEffort` 使用 `AgentRequest` 中显式传入的值，省略时沿用模型/provider 默认。context 预算估算须包含实际发送的消息和 tools。
3. 若 `contextTokenBudget === 0`，无条件返回 `context_limit`；否则估算值大于预算时返回 `context_limit`，保留 trajectory。预算未设置时不执行该 loop guard。这一检查在发起下一次模型请求之前。软停止优先于 context pause，与现有 `ReAct.RunCoreAsync` 次序一致。
4. 进入模型相位，iteration 加一。`ChatModel.stream` 已返回高层 `ModelEvent`：按序转发 text / reasoning / tool-call argument delta；收到唯一 `completed` 后取完整 `ModelResponse`。底层 provider `ProviderChunk` 和 block assembler 不属于 loop API。
5. 累加 response usage/cost；把完整 assistant message 加到 trajectory；`await checkpoint.appendMessage`；发 `turnCompleted`。该事件对应一次模型调用完成（沿用旧 `AgentLoopEvent.TurnCompleted`），不是整个 session turn 已结束。不可重试 `LlmFailure` 转成 `error` stop result 并发 `runFailed`；retry wrapper 在允许边界重试，最终未处理的 retryable/transport exception 抛给宿主，不伪装成答案。
6. 无 tool call 时返回 `answer`。有 tool call 时先检查软停止；若 requested，返回 `interrupted`，绝不启动尚未开始的工具。按模型给出的调用顺序逐个处理：命中 final output tool 则参数作为答案并返回；达到显式正值 max iteration 时不执行剩余调用；否则 validator 校验、await `beforeToolExecution`、检查 hard signal、await checkpoint intent、attempt `toolStarted` notification (observer failure is isolated)、执行工具、attempt `toolCompleted` notification (observer failure is isolated)、把 observation 加 trajectory、await checkpoint result。
7. 已执行工具后回到步骤 1/2；调用所有终止路径返回完整可观察轨迹和已产生 usage。

事件 union 的 Core 内部命名以 camelCase 为准，至少保留 `textDelta`、`reasoningDelta`、`toolCallDelta`、`turnCompleted`、`toolStarted`、`toolCompleted`、`runFailed`、`interrupted`。`toolCallDelta` 的 arguments 是截至目前累计的原始 JSON 字符串，可能不完整；不能提前当有效 JSON parse。RPC 和 TUI local adapter 都显式把内部事件转回现有 `tui/src/rpc/protocol.ts` wire union（保留 `kind` snake_case 与 payload snake_case）；UI 状态机因此不用在本次 Core 迁移中重写。

## 中断、取消与并发生命周期

- `AbortSignal` 是硬取消。通过 model stream、retry delay、tool executor、checkpoint 中支持取消的 IO 透传同一个 signal。模型流中途、工具执行中取消都拒绝当前 `runTurn`；保留已写 checkpoint 并执行 session recovery，不能把可能有副作用但没有完成记录的工具结果臆造为成功。
- `requestSoftStop()` 是软中断：置位当前 turn 的 stop request；loop 仅在“启动下一次模型调用前”和“模型刚返回 tool calls、工具尚未启动时”检查。正在运行的模型流或工具允许自然完成。已经完成工具观察保留，再正常返回 `interrupted`。TUI `RunnerPort.interrupt()` 不调用这个方法，它首按 Ctrl+C 仍执行硬取消。
- 一个 `AgentSession` 同时只能有一个运行中的 turn。首期唯一策略是拒绝第二个 prompt，并返回既有 RPC error envelope `{ type: "error", code: "busy", message: ... }`；不得并行复用可变历史，也不得等待本回合后再消费第二条 prompt。RPC 行循环保持可读，后续 `interrupt` / `shutdown` 仍能到达。Di 当前 `RpcMode` 会等待已有 turn 后再处理 prompt；TS 的 busy rejection 是有意改变并发客户端行为。现有 TUI 已在 `main.ts` busy 状态拒绝 Enter，正常交互不触发该变化。
- turn 完成后清理当前 controller 和 listener，不能把旧 signal 或软停止 flag 带入下一回合。`resetHistory` 只能在无 running turn 时执行；否则返回 busy / 明确 abort 后 reset，不允许并发清空正在用的数组。
- model / skill 修改在 turn 边界生效；不要在一半模型流中替换依赖。TUI 的 command 调用与 prompt 共用 session mutex/串行政策。

## iteration 与停止理由

Di 当前默认 `AgentLoopOptions.MaxIterations = 0` 表示不限制；正整数是显式最大模型迭代数。迁移不得添加默认次数上限，也不得把“安全建议”偷偷转成默认配置。若实现层保留该选项：负值在 session 创建/配置解析时拒绝，0 无限，N 的确切含义是最多 N 次模型调用；工具调用响应之后如 N 已耗尽，不执行该 assistant message 中未执行的工具并返回 `max_iterations`，轨迹保留尚未配齐的 tool calls。宿主持久历史必须再执行 `sanitizeHistory` 去掉尾部未配齐调用组，不能破坏结果里供 UI / replay 使用的完整 trajectory。

映射：正常文本终结 `answer`；final output tool `final_output_tool`；显式封顶 `max_iterations`；不可重试模型错误 `error` + failure；软停止 `interrupted`；预算拒绝下一次模型调用 `context_limit`；AbortSignal rejection 由宿主输出 wire `cancelled`（RPC 兼容层）或 CLI 中断退出语义，不属于正常 loop stopReason。外部 `docs/tui-rpc.md` 当前结果字段仍保留原 snake_case 和既有 stop reason string。

## AgentSession 历史与恢复

session history 是跨回合 memory，不是当轮 UI transcript 的别名。每轮把完整 trajectory 加入 history（包括环境快照 system message、user、assistant、tool results），再按估算预算丢掉最旧整 user-turn；保存前只修整尾端不完整工具组。模型构造 context 时顺序与当前实现一致：stable `SystemPrompt` 在最前；memory 和当前 user；每回合易变 skills advertisement/activated skill instructions 置于请求尾部。environment snapshot 是变更时追加的历史 system message，避免每回合重复注入稳定字节前缀。

`ContextLimit` / `context_limit` 是显式暂停。若某次完整 request estimate 将越过预算，返回带完整 trajectory 的结果并将历史设为 `preserveHistoryUntilReset = true`。后续调用不得自动裁剪该暂停轨迹、不得自动生成摘要或擅自删掉失败任务上下文；用户缩小任务或显式 reset 之前应保持原样。history trim 预算变化不应静默破坏该保护标志。

估算是启发式近似（不保证高估），不是 provider exact token count。现实现 `ReAct.EstimateRequestTokens` 以 UTF-8 bytes / 3 加每条消息/tool 的 overhead 估算整次 request；runner `EstimateTokens` 另用 `TokenEstimator` 估历史可见文本和 reasoning。TS 版本必须命名为 estimate，并以单元测试锁定与 request builder 使用同一消息顺序和 tools；不要把 UI 显示值、账单 usage 或模型窗口目录当成 estimate 的真值。纯 loop 不调用 Node `Buffer` 或文件 API：整 request estimate 由显式 `estimateRequestTokens(ModelRequest)` 依赖注入，或实现无 Node 依赖的 UTF-8 helper。预算策略保留当前公式和水位顺序（先从窗口扣 output reserve 与 margin 得 `B_input`，再计算 soft/hard/blocking）；L1 tool output spill 仍是宿主 tool executor 的 decorator，不下沉纯 loop。

若当前模型窗口未知或 model catalog 查询失败，兼容路径不应该凭空制造 token limit。跨回合 history 默认只受实际已知的 token budget 约束；`maxHistoryTurns` 仅在调用者显式设置正数且没有 token budget 时兜底，缺省 0 表示不启用轮数上限。Budget tracker 反馈估算值而非 billed usage；工具执行前 tracker 必须能看到本轮已累积的 assistant/tool trajectory，回合末再同步裁剪后的 memory 估算值。

recovery 的 checkpoint 时序维护当前 fail-closed 约束：task 开始记录 user input 与开始状态；对每个模型 assistant 消息和 tool intent/result 顺序追加；tool intent 已写入、却缺结果时重启恢复必须认定副作用结果未知，阻止同 session 自动继续。Recovery 验证完成后才可恢复 history；验证失败记下 blocked reason，要求 reset/new session 或人工核查。持久文件每条 JSONL 记录保留现有 envelope 和 snake_case 格式，不以 TS interface 内部命名自动序列化。

## 逐单元红绿实施与验收边界

每个单元先新增针对行为的 `node:test` 测试，单独观察失败，再写最小实现并观察通过。使用当前 lockfile 固定的 Node/TypeScript 版本；不安装或运行 Pi。先完成纯 loop，再做宿主、工具、持久化和接线，保持每步可以调用。

| 单元 / 未来测试位置 | 先写的失败行为测试 | 实现后必须通过的验收 |
|---|---|---|
| `packages/agent/test/agent-loop.test.ts` | 纯文本结束、两轮 tool cycle、完整轨迹顺序、usage 累加、final tool 答案 | 不引用 Node API；注入假 model/tool；每个请求只累计本次 usage |
| loop phase / cancellation tests | 模型流开始前 abort；流中 abort；工具中 abort；soft stop 在模型前和 tool-call 后；工具执行途中软停只在工具结束后生效 | hard abort rejection，soft stop 有 `interrupted` partial result；没有越过未启动相位的事件/副作用 |
| stream / event tests | 累计 tool arguments 分片、reasoning/text 顺序、async sink 顺序、event listener 与诊断回调各自抛错、checkpoint/validator 抛错 | delta 原串保留；await observer 保序且捕获错误后继续；observer 抛错仍执行已授权工具；checkpoint/validator 错误停止且未授权工具不执行 |
| context / iteration tests | context estimate 恰等预算、超 1、budget=0；默认无限、显式 1；一条 assistant 有多个 tools、N 上限后未执行部分 | 预算检查发生在模型请求前；context_limit 保留轨迹；iteration 不被默认封顶；完成工具数与上限语义明确 |
| checkpoint tests | message checkpoint 失败；tool intent checkpoint 失败；tool result checkpoint 失败 | assistant 和 intent 写入先于任何相应副作用；结果 checkpoint 失败时下一次模型不启动 |
| `packages/coding-agent/test/agent-session.test.ts` | 回合 A history 出现在回合 B；model/skills 切换边界；stable snapshot 只变更时追加；同 session 并发 prompt/reset | 有状态只在 host；暂停恢复标志生效；会话 busy 策略一致 |
| history / recovery tests | 整 user-turn trim、保留最近一轮、未配齐 tool calls sanitize；ContextLimit 之后下一轮不 trim；未知 intent fail-closed | 结果 trajectory 不改写，持久 history 良构；checkpoint/recovery 可重放且未知副作用被阻止 |
| budget / artifact tests | 无 model window、provider resolver 抛错、估算预算边界、非白名单/写操作不 spill、artifact 写失败 | 预算仅 approximate；无窗口不发明限制；spill 不丢原始结果；安全/错误边界保留现状 |
| runner seam / RPC contract tests | 同一事件分别经 RpcClient 与 local adapter；subscribe-before-connect、ready 恰好一次且先于 connect resolve；prompt 单次 result callback；hard interrupt/cancelled、clear history、set model/skills、list/run command、ping、stop；旧 wire fixtures；busy prompt 后仍可处理 interrupt；未知事件兼容 | TUI app 继续消费 protocol.ts wire union；local adapter 显式映射 camelCase Core events；首按 Ctrl+C 仍硬取消；RPC busy prompt 立即拒绝且不阻塞读取；正常逐行协议/seq 保持 |

`maxIterations` 验证为整数且 `>= 0`，0 明确表示无限；`maxTokens` 若提供则必须是正整数；`contextTokenBudget` 若提供则必须是整数且 `>= 0`；`reasoningEffort` 是 opaque 字符串，合法值由所选模型/provider adapter 校验，并保留当前未支持值的错误语义。超界在 loop/session 启动时以明确参数错误拒绝，不能静默 clamp。

细节上易漏：空文本与空工具列表；provider 空 stream / 缺 finish；工具异常转 `isError` observation 而非 loop 崩溃；tool call id 不唯一/乱序片段；reasoning 不得混入 answer；模型累计 usage 在工具循环多次调用时求和；多工具里第一个失败观察后仍按当前语义处理后续工具；AbortError 不能被通用工具错误捕获转换成普通 observation；checkpoint 的同步落盘成功点必须在工具副作用前；max iteration 结尾的 orphan tool calls 只在跨回合历史中 sanitize；ContextLimit 输入恰好等预算可继续，超过才暂停（0 预算除外）；observer listener 重入 prompt 时按 busy policy 拒绝。

首期不迁移 Pi extension / plugin / package registry、sub-agent / plan mode、会话分支编辑、steering queue、并行工具执行、auto compaction / 摘要、任意技能热重载、改变旧 RPC schema、删除 C# 兼容实现。迁移一个既有功能时，以 Di 源码和对应文档行为为准，不为了与 Pi 相似而增加这些能力。

## 现状证据

- `Core/AgentLoop/ReAct.cs` 的 `RunCoreAsync` 检查软停止、context estimate、调用模型、写 checkpoint、执行工具并在边界返回 stop reason；`EstimateRequestTokens` 计入工具 schema，并声明 UTF-8/3 是 guard。
- `Core/AgentLoop/AgentRunner.cs` 的 `AgentRunner.RunAsync` 管 model resolve、skill context、snapshot、预算请求裁剪、recovery 和回合后 memory；`TrimHistoryByTokens` 按整轮裁剪，`SanitizeHistory` 只修持久历史尾端工具良构性。
- `Core/AgentLoop/AgentRequest.cs` 当前 checkpoint callback 是同步 `Action`；TS 如允许 async，必须 await 后才进 side effect，不能降低写前意图约束。
- `Core/AgentLoop/AgentLoopOptions.cs` 当前 `AgentLoopOptions.MaxIterations = 0` 是无限；`Core/AgentLoop/AgentResult.cs` 定义 `AgentStopReason.ContextLimit` 为保留轨迹并等待缩短或重建任务。
- `Core/ContextManagement/BudgetPolicy.cs` 是有序水位线与估算策略；`Core/Sessions/SessionLog.cs` 通过追加 JSONL 和锁内序号记录 checkpoint。
- 旧 CLI/RPC 的 event / result 映射在 `Di.Cli/modes/RpcMode.cs` (`EventPayload`, `ResultPayload`)；TUI wire types 在 `tui/src/rpc/protocol.ts`；既有协议权威文档是 `docs/tui-rpc.md`。
