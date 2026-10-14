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
{"type":"ready","version":"0.1.0","model":"deepseek-flash","effort":"high","skills":[{"name":"backend-tests","description":"跑后端测试"}],"models":[{"id":"deepseek-flash","name":"DeepSeek Flash"}]}
```

组合根（`CliHost`）构建完成、可服务请求后发出，仅一次。携带会话元数据快照，TUI 据此渲染
右下角状态栏（模型 + 强度）与命令补全（`/model`、`/skill`）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `model` | string | 当前生效模型名（`/model` 可切换） |
| `effort` | string? | 推理强度（off/low/high/max 等；启动时由 `--thinking` / 配置固定，运行期暂不可切）。null 键省略 |
| `skills` | `[{name,description}]` | 可见 skills（`/skill` 补全与一次性执行） |
| `models` | `[{id,name}]` | 模型目录（`/model <Tab>` 参数补全） |

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
| `interrupted` | 无 | `Interrupted`（软停止：回合将在相位边界收敛，见 `docs/interrupt.md`） |

`TokenUsage`（snake_case，null 键省略）：
`{input_tokens, output_tokens, total_tokens?, cache_read_tokens?, cache_write_tokens?, reasoning_tokens?}`。

### 2.3 `result`

```json
{"type":"result","seq":<int>,"result":{
  "answer": string,
  "stop_reason": "answer"|"final_output_tool"|"max_iterations"|"error"|"cancelled"|"interrupted",
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
- 软停止 → `stop_reason: "interrupted"`（`AgentStopReason.Interrupted` 直接映射，Core 原生；
  回合在相位边界收敛，先发一个 `interrupted` 事件再发 `result`）。见 `docs/interrupt.md`。

### 2.4 `error`

```json
{"type":"error","code":string,"message":string}
```

会话级不可恢复错误（如凭据缺失，code 沿用 `LlmErrorCodes`）。回合内失败走 `run_failed` /
`result.stop_reason:"error"`，不用 `error` 消息。

### 2.5 命令应答（`command` 请求的同步应答）

`{"type":"request","method":"command",...}` 的应答为以下三种之一：
**按请求序同步返回**（命令处理期间主循环不读下一条请求，不与事件流交错）：

```json
{"type":"command_listed","commands":[{"name":"clear","description":"清空屏幕与对话记忆","argument_hint":null}]}
{"type":"command_ran","name":"model","lines":["模型已切换为 deepseek-chat"],"exit":false,"model":"deepseek-chat","effort":"high"}
{"type":"command_error","code":"turn_not_supported","message":"命令 /skill 是回合型命令，TUI 应改用 prompt 执行","turn_message":"【Skill：backend-tests】跑后端测试\n\ndotnet test\n\n补测试"}
{"type":"command_error","code":"unknown_command","message":"未知命令: /bogus"}
```

- `command_listed`：`list` 应答，列出注册表全部命令（内置 + 用户命令，按名排序）。
  `commands[i] = {name, description, argument_hint?}`。
- `command_ran`：`run` 应答；`lines` 为命令输出行（无 ANSI），`exit=true` 表示命令请求退出
  （如 `/exit`，TUI 自行决定是否发 `shutdown`）。`model` / `effort` 为命令执行后的模型/强度
  快照（`/model` 切换后 TUI 据此更新状态栏，不依赖解析提示文本）。
- `command_error`：命令级错误（**不含在 `error` 会话级语义内**）：
  - `unknown_command` —— 注册表无此命令；
  - `turn_not_supported` —— 回合型命令（`/skill <名> <参数>`、用户命令）：RPC 无回合执行器，
    应答携带 `turn_message`（指令+参数全文），TUI 据此**改用自身 `prompt` 机制跑回合**；
  - `invalid_request` —— 参数非法（缺 `name`、类型错误等）。

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
| `interrupt` | `{}` | **硬取消**当前回合 → 对应 `result.stop_reason:"cancelled"`（软停止尚未接线到本协议，见 `docs/interrupt.md` §7） |
| `set_model` | `{model: string}` | `AgentRunner.CurrentModel` |
| `set_skills` | `{names: string[]}` | `AgentRunner.ActiveSkills` |
| `clear_history` | `{}` | `AgentRunner.ResetHistory()` |
| `command` | `{list?: true}` 或 `{name: string, args?: string}` | 列出（`list: true`）或运行（`name`，可选 `args`）斜杠命令；应答见 §2.5。回合型命令返回 `command_error: turn_not_supported` |
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
