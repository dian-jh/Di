# TUI RPC 协议

`--mode rpc` 使用 UTF-8 NDJSON：stdin 每行一个请求，stdout 每行一个响应或事件；stderr 用于
诊断。编码/校验代码在 `tui/src/rpc/codec.ts`（`encodeMessage`、`parseMessage`），双端类型在
`tui/src/rpc/protocol.ts`，TUI 客户端在 `tui/src/rpc/client.ts`，后端在
`packages/coding-agent/src/modes/rpc-mode.ts`（`runRpcMode`）。输出采用 snake_case，未定义的可选
字段省略。行内未知字段可忽略，但未知消息类型或事件 kind 会报协议错误。

## 后端到 TUI

启动时发送一次 `ready`：`version` 必填；当前 `model`、推理 `effort`、`skills` 和 `models` 可选。
模型 id 为 `provider/model`，skill 项含 `name` 与 `description`。

流式事件外层为 `{"type":"event","seq":N,"event":{...}}`，序号在每个回合内递增，最终
`result.seq` 大于该回合的事件序号。事件载荷：

| `event.kind` | 字段 |
|---|---|
| `text_delta` / `reasoning_delta` | `delta` |
| `tool_call_delta` | `id`、`name`、累积的原始 JSON `arguments` 字符串 |
| `tool_started` | `call`（`id`、`name`、`arguments`） |
| `tool_completed` | `call`、`observation`、`is_error` |
| `turn_completed` | `iteration`、`usage`、可选 `cost`、`finish_reason` |
| `run_failed` | `failure`（`code`、`message`，可选 HTTP `status` / `provider_retry_after`） |

每个 `prompt` 恰好产生一个终结 `result`，包含 `seq` 和 `result`；结果字段为 `answer`、
`stop_reason`、`iterations`、`usage`，以及可选 `cost`、`failure`。`usage` 至少含
`input_tokens`、`output_tokens`，其它 token 计数可省略。停止原因包括 `answer`、
`final_output_tool`、`max_iterations`、`error`、`interrupted`、`context_limit`、`cancelled`。
RPC `interrupt` 取消正在运行的回合，终结结果使用 `cancelled`。软停止事件不会单独编码到 wire。

会话级错误为 `{"type":"error","code":"…","message":"…"}`。后端还发送
`command_listed`、`command_ran`、`command_error`；命令列表字段为 `name`、`description`、可选
`argument_hint`。命令结果含 `lines`、`exit`，并可包含模型目录、当前模型及 `effort` 快照。

## TUI 到后端

请求格式为 `{"type":"request","id":N,"method":"…","params":{…}}`。客户端递增 `id`，但
当前后端不在输出中回显 id；客户端只允许单个 prompt / command 未完成，并按 stdout 顺序读取
`event`、`result` 和命令应答，不要把 id 当作应答关联键。

| `method` | `params` | 行为 |
|---|---|---|
| `prompt` | `message` 字符串 | 开始回合；回合执行期间后端继续读取请求 |
| `interrupt` | `{}` | 取消当前回合 |
| `set_model` | `model` 字符串 | 切换模型；运行中的回合返回 `busy` |
| `set_skills` | `names` 字符串数组 | 设置固定启用的 skill，未知名称忽略 |
| `clear_history` | `{}` | 清空内存会话历史 |
| `command` | `{list:true}` 或 `{name,args?}` | 列命令或运行同步命令 |
| `ping` | `{}` | 心跳，不回包 |
| `shutdown` | `{}` | 等待当前回合结束后正常退出 |

请求按 stdin 行序列处理。回合执行在后台进行，`interrupt` 和 `shutdown` 可在回合期间到达；新
`prompt` 会先等上一回合结束。语法错误返回 `parse_error` 并继续读后续行；缺字段返回
`invalid_request`；未知 method 返回 `unknown_method`。正在运行时切换模型返回 `busy`；无效模型
返回 `invalid_model`。`command` 对未知命令返回 `unknown_command`，回合型命令返回
`turn_not_supported` 并附 `turn_message`，由 TUI 再发 prompt。`ping` 无应答；stdin EOF 会等当前
回合结束再以 0 退出。

## 启动与 TUI 接线

`tui/src/rpc/backend-launcher.ts` 的 `buildBackendLauncher` 优先采用显式 `DI_BIN`，否则定位
workspace 编译入口或 TUI 同级安装包中的 `@di/coding-agent` 编译入口，并使用当前 Node 启动。
TUI 通过 `tui/src/runner/rpc-port.ts` 将 RPC client 映射到 `RunnerPort`，再由
`tui/src/interactive.ts` 的 `runInteractive` 驱动界面。生产 CLI 的本地 runner adapter 位于
`packages/coding-agent/src/adapters/tui-runner.ts`。
