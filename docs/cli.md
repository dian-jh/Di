# CLI 契约

入口为 `packages/coding-agent/src/cli/main.ts`。它创建 `CliApp`，注入 stdin/stdout/stderr 和
TTY 状态，最后把 `CliApp.runAsync` 返回值设为进程退出码。参数解析由
`packages/coding-agent/src/cli/args.ts` 的 `CliArgsParser.parse` 负责，模式推导由
`packages/coding-agent/src/cli/mode.ts` 的 `CliMode.resolve` 负责。

## 参数

| 参数 | 行为 |
|---|---|
| `-m, --model <id>` | 指定模型；单发模式在运行回合前切换模型 |
| `--provider <id>` | 覆盖配置中的 provider |
| `--mode interactive\|print\|json\|rpc` | 显式指定运行模式 |
| `--print` | 强制文本单发 |
| `--thinking <effort>` | 覆盖推理强度 |
| `--list-models [pattern]` | 列出可用模型，可选模式匹配 id/provider |
| `--stats <file>` | 离线聚合会话 JSONL 统计 |
| `--skill-eval <file>` | 按标签用例评估 skill 匹配器 |
| `--resume <file>` | 从 checkpoint 恢复并进入交互模式 |
| `--no-session` | 单发/RPC 不写会话记录 |
| `--no-ansi` | 禁用 ANSI 输出 |
| `-h, --help` / `--version` / `--info` | 显示帮助、版本或运行环境和生效配置 |

`--` 后所有 token 都作为位置参数。值参数必须跟随一个不以 `-` 开头的值；解析器对未知参数、
缺值和非法模式报错，不会静默忽略。`auth` 子命令在普通参数解析前分派。

ChatGPT OAuth 子命令为 `di auth chatgpt login [--new|--consent]`、`status`、`models`、
`logout`；`--new` 开始另一账户登录，`--consent` 重新申请 plan 授权。命令实现位于
`packages/coding-agent/src/cli/auth-command.ts`。

## 模式选择

解析错误会写 stderr 并返回退出码 1。没有错误时，优先级为：版本/info/help/list-models/stats/
skill-eval 短路径；显式 `--mode`；位置提示词转 print；单独 `--resume` 转 interactive；最后按
`--print` 与 stdin/stdout 是否为 TTY 决定 print 或 interactive。`--resume` 进入等待用户输入的
交互流程，不会自动发送模型请求。`--list-models`、`--skill-eval` 及交互/单发/RPC 路径需要先
创建 host；`--version`、`--info`、`--help` 和 `--stats` 是不创建 host 的短路径。

CLI 分派位于 `packages/coding-agent/src/cli/cli-app.ts`（`CliApp.runAsync`）：print、JSON、RPC
实现分别位于 `packages/coding-agent/src/modes/print-mode.ts`（`runPrintMode`）、
`packages/coding-agent/src/modes/json-mode.ts`（`runJsonMode`）、
`packages/coding-agent/src/modes/rpc-mode.ts`（`runRpcMode`）。交互由
`packages/coding-agent/src/modes/repl.ts` 的 `runInteractive` 管理；交互式 TTY 默认尝试同进程
TUI，`DI_UI=repl` 可指定 REPL。会话和 loop 装配见
`packages/coding-agent/src/core/agent-session.ts`（`AgentSession`）与
`packages/agent/src/agent-loop.ts`（`runAgentLoop`）。

## 输出与退出码

成功返回 0；参数错误、空提示词、宿主初始化失败或回合失败返回 1。文本单发的回答与流式状态写
stdout，错误写 stderr；重定向输出不显示 ANSI，也不输出交互状态行。`--mode json` 每次只向
stdout 写一行 JSON：成功包含 `answer`、`stop_reason`、`iterations`、`usage`，已知成本时含
`cost`；失败为 `{"error":{"code":"…","message":"…"}}`，退出码为 1。`--no-session`
关闭持久化，默认会写 session JSONL。

会话文件和恢复实现分别见
`packages/coding-agent/src/core/sessions/session-log.ts`（`SessionStore`）与
`packages/coding-agent/src/core/sessions/session-recovery.ts`（`loadRecovery`）。checkpoint 中
工具调用结果不确定时恢复会失败关闭，以免重复执行可能已产生副作用的工具。

模式线协议见 [`docs/tui-rpc.md`](tui-rpc.md)；配置文件位置和优先级见
[`docs/di-home.md`](di-home.md)。发布验证状态见
[`docs/typescript-validation.md`](typescript-validation.md)。
