# Di RPC 协议（`--mode rpc`）：线协议唯一权威

> 唯一权威：TS TUI（`tui/`）与 `di --mode rpc`（C# 后端）之间的进程边界协议。
> 双端实现**必须**与此文档逐字段一致；事件载荷形状以 `Core.AgentLoop.AgentLoopEvent` 为准
> （事件类型表唯一权威：`docs/modules/events.md`）。
>
> 配套文档：`docs/tui.md`（设计）、`docs/cli.md`（CLI 契约与跨语言重写指南）。

---

## 1. 传输与帧

- 子进程 **stdin / stdout** 均为 UTF-8 文本流；**每行一个 JSON 对象**（NDJSON），以 `\n` 结尾。
- stdout 上的每个事件 / 结果必须**立即 flush**（实时流式）。
- **stderr 不参与协议**（仅日志 / 诊断）。
- **无背压协商**：请求串行处理，事件顺序 = 发布顺序；一次 `prompt` 请求对应一段连续事件流
  并以一个 `result` 终结。
- TUI 等到 `ready` 之后才开始发请求。

## 2. 方向 核心 → TUI（stdout）

### 2.1 `ready`

```json
{"type":"ready","version":"0.1.0"}
```

组合根（`CliHost`）构建完成、可服务请求后发出，仅一次。

### 2.2 `event`

```json
{"type":"event","seq":<int>,"event":{"kind":"<kind>", ...}}
```

`seq` 单调递增（回合内连续）。`kind` 与载荷：

| kind | 载荷字段 | 对应 `AgentLoopEvent` |
|---|---|---|
| `text_delta` | `delta: string` | `TextDelta` |
| `reasoning_delta` | `delta: string` | `ReasoningDelta`（M1 新增，转发 `ModelEvent.ReasoningDelta`） |
| `tool_call_delta` | `id,name,arguments`（arguments 为迄今原始 JSON 串，可能未完成） | `ToolCallDelta`（M1 新增，转发 `ModelEvent.ToolCallDelta`） |
| `tool_started` | `call: {id,name,arguments}` | `ToolStarted` |
| `tool_completed` | `call: {id,name,arguments}`, `observation: string`, `is_error: bool` | `ToolCompleted` |
| `turn_completed` | `iteration: int`, `usage: TokenUsage`, `cost?: number`, `finish_reason: string` | `TurnCompleted` |
| `run_failed` | `failure: {code,message,status?,provider_retry_after?}` | `RunFailed` |

`TokenUsage`（snake_case，null 键省略）：
`{input_tokens, output_tokens, total_tokens?, cache_read_tokens?, cache_write_tokens?, reasoning_tokens?}`。

### 2.3 `result`

```json
{"type":"result","seq":<int>,"result":{
  "answer": string,
  "stop_reason": "answer"|"final_output_tool"|"max_iterations"|"error"|"cancelled",
  "iterations": int,
  "usage": { ...TokenUsage },
  "cost"?: number,
  "failure"?: {"code": string, "message": string}
}}
```

- 每个 `prompt` 请求**恰好一个** `result`，为该回合的终结。
- 位于 `prompt` 与 `result` 之间的全部 `event` 属于该回合。
- 中断取消 → `stop_reason: "cancelled"`（C# 侧由 RpcMode 捕获 `OperationCanceledException` 合成；
  `AgentStopReason` 无此值，故由宿主层映射，不落 Core）。

### 2.4 `error`

```json
{"type":"error","code":string,"message":string}
```

会话级不可恢复错误（如凭据缺失，code 沿用 `LlmErrorCodes`）。回合内失败走 `run_failed` /
`result.stop_reason:"error"`，不用 `error` 消息。

## 3. 方向 TUI → 核心（stdin）

每行一个请求：

```json
{"type":"request","id":<int>,"method":"<m>","params":{...}}
```

- 请求**串行**处理（按行序）；`prompt` 处理中收到 `interrupt` → 取消当前回合。
- 无逐请求回执；对 `prompt` 的"回执"即 stdout 事件流 + 一个 `result`。`id` 保留给未来
  并行请求（如列表会话），当前恒单调递增即可。

| method | params | 语义 |
|---|---|---|
| `prompt` | `{message: string}` | 运行一回合（等价 `IAgentRunner.RunAsync`）；事件流 + `result` |
| `interrupt` | `{}` | 取消当前回合 → 对应 `result.stop_reason:"cancelled"` |
| `set_model` | `{model: string}` | `AgentRunner.CurrentModel` |
| `set_skills` | `{names: string[]}` | `AgentRunner.ActiveSkills` |
| `clear_history` | `{}` | `AgentRunner.ResetHistory()` |
| `ping` | `{}` | 心跳，无应答 |
| `shutdown` | `{}` | 优雅退出，exit 0 |

## 4. 约定与不变式

- **序列化**：snake_case；null 键省略；宽松 UTF-8 转义。与 `Di.Cli/modes/PrintMode.cs` /
  `Core/Sessions/SessionLog.cs` 的 `JsonSerializerOptions`（`PropertyNamingPolicy = SnakeCaseLower,
  DefaultIgnoreCondition = WhenWritingNull, Encoder = UnsafeRelaxedJsonEscaping`）保持一致。
- **UTF-8**：后端启动时固定 `Console.OutputEncoding/InputEncoding = UTF-8`（沿
  `Di.Cli/Program.cs` 惯例；GBK 代码页下防乱码）。
- **失败是消息不是崩溃**：回合失败 → `run_failed` 或 `result.stop_reason:"error"`；协议解析失败
  → `error` 消息后继续（或按行号报告）。
- **向后兼容**：TUI 对未知 `kind` 应忽略并告警，不得崩溃。
- **退出码**：`shutdown` → 0；stdin EOF → 结束当前回合后 exit 0；其余异常 exit 1（沿
  `docs/cli.md` 退出码契约）。

## 5. 实现映射（源码为最终权威）

| 端 | 位置（相对仓库根） |
|---|---|
| C# 模式分派 | `Di.Cli/cli/CliMode.cs`（`AppMode.Rpc`）+ `Di.Cli/CliApp.cs`（分派到 RpcMode） |
| C# 后端宿主 | `Di.Cli/modes/RpcMode.cs`（新增） |
| C# 事件转发 | `Core/AgentLoop/ReAct.cs`（`ReasoningDelta`/`ToolCallDelta` 补发）+ `Core/AgentLoop/AgentLoopEvent.cs`（新记录） |
| TS 类型 | `tui/src/rpc/protocol.ts` |
| TS 编解码 | `tui/src/rpc/codec.ts` |
| TS 子进程客户端 | `tui/src/rpc/client.ts` |

> 事件类型表（`AgentLoopEvent` 全量载荷）唯一权威在 `docs/modules/events.md`，本页只定义线格式
> 与映射关系，不复制载荷定义。
