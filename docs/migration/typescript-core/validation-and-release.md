# TypeScript Core 验证与发布蓝图

> 状态：未来迁移方案；当前没有 TypeScript Core 可执行脚本，也没有 tracked CI workflow。阶段与统一 gate 见 [`execution-plan.md`](execution-plan.md)；架构/包职责见 [`architecture.md`](architecture.md)。本文仅规范协议验证、兼容验收和切换风险控制。

## 验收原则

验收按用户可观察行为与数据安全语义做，不以 TS 测试数等于旧测试数作为目标。现有基线快照是 943 项 .NET 非集成测试、116 项 TUI 测试；它只描述一次验收，不是未来永久门槛。应逐项映射行为，补足旧测试未覆盖的跨进程损坏、双向格式兼容与平台差异。

TDD 每个工作单元遵循：先在目标 workspace 写 `node:test` 行为测试，运行确认失败且失败原因对应缺失行为；实现最小逻辑；重跑对应测试到绿；最后跑包级 typecheck/test。未来建议脚本命令是 `npm test --workspace @di/coding-agent`、`npm run typecheck --workspace @di/coding-agent` 等，只有 P 阶段真正创建 scripts 后才可执行。在对应 scripts 落地前不要报告这些命令已存在或已运行。暂不要求为文档任务运行 .NET/TUI 套件；迁移实现时根据变更执行对应 gate。

TS 与 C# 比较时规范化易变的 timestamp、cwd、随机 session id 和随机 turn id。不可规范化/抹去工具 `call_id`、`name`、原始 `arguments` 字符串、message ordering、record ordering、started/result 先后。对 JSON 对象字段顺序可按语义比较；另有 writer byte fixture 时再断言输出 key 顺序、UTF-8 和 LF。

## 分层测试计划

### 语言中立 fixture 与单元测试

在未来的 `packages/coding-agent/test/fixtures/sessions/` 存公开、不含凭据的 fixture：完整审计轮、完整 checkpoint 工具轮、多轮 history snapshot、assistant-only、started-only、completed、未知 record、未知 block、重复/孤立 call id、破损完整行、torn final line、legacy 审计文件。fixture 由 `Di.Tests/Sessions/SessionLogTests.cs` 已有断言整理，不手抄有噪音的时间和绝对路径。增加 manifest 写明期望结果和 fixture 来源提交 `09f4e0816c1b2dc42461e79a968b46e811d3880c`。

`node:test` 单测至少覆盖：envelope 顺序/ordinal、snake_case、UTF-8/no BOM、null 省略、audit 与 checkpoint 分离、checkpoint 读取/写入、工具调用参数逐字保存、每种 crash prefix、安全恢复与 fail closed、unknown 类型、坏行、历史 clear、ContextLimit。测试应直接检查模型 fake 收到的消息和 fake executor 调用记录。

### faux model / faux executor loop 测试

复用可控脚本模型返回确定的 assistant/tool-call/assistant 响应，不接外部服务。fake executor 记录开始与完成、call id/name/args、次数及可选磁盘 marker。注入每个持久化边界的故障，断言：started write 失败时工具完全没被调用；普通工具异常变为 `is_error=true` observation 并写 completed，随后可继续；取消 token 已取消且 started 后无 completed、或 completed 写失败，则执行结果未知，同 runner 后续调用被拒绝；completed 已写后模型再次失败，同进程继续使用保存结果且不重复副作用；不同 assistant batches 可复用相同 call id，但同一批重复不接受。模型 request 列表逐条按消息顺序比对。

另测 `/clear` 后新 checkpoint 写空 history，恢复后不复活 clear 前对话；普通新 turn 的 history 快照保留当时仍在内存中的旧消息并以其为恢复基底。`ContextLimit` 暂停保留原任务和已完成工具结果并可在扩大预算后继续。`--resume` 在新 runner 中载入同一历史、不会为恢复而先调用模型或重放工具；同时保持 `CliMode.Resolve` 行为：显式 `--mode` 优先，未指定时 positionals 仍选 print，随后才按 `--resume`/`--print`/TTY 推导默认模式。因此测试需覆盖 `--resume` 单独使用、与显式模式组合、与 positionals 组合，不能规定它总进入 REPL。这些测试对应 [会话兼容契约](sessions-and-compatibility.md) 中的现有 Di 测试矩阵。

### 本地 HTTP SSE 集成与真实进程崩溃

在未来 `packages/coding-agent/test/integration/` 用 Node 内建 HTTP server 仿 SSE provider，逐片返回固定响应/usage/异常，并把接收的 request body 保存到测试日志。它验证 provider adapter→loop→tool→session writer 的接线、stream 结束和错误路径，不需要真实模型、网络服务或 API key。用断言核对工具调用 JSON 文本和 request 次序；临时监听本机回环地址。

进程崩溃采用 child process，临时 `DI_HOME`，只用 test-only failpoint 或测试 executor 控制退出点：

- 在 `checkpoint_tool_started` flush 后、工具执行前 kill：reload 得到 unknown intent 并拒绝自动执行；
- fake 外部副作用 marker 已落盘、`checkpoint_tool_completed` 尚未写入时 kill：reload 仍拒绝重试，并保留 marker 证明副作用窗口真实存在；
- completed flush 后、下一模型请求前 kill：reload 保留唯一一份结果，继续时 executor 不重复调用；
- 写入半条 JSON 后 kill：只忽略无 LF 的最后行；同样字节若加 LF 成完整坏行则拒绝。

父进程要有 timeout、捕获 exit code/stderr 并清理 temp root；Windows child kill 及文件句柄释放单独纳入平台验证。不要用 `process.exit()` 的正常清理路径冒充 crash test。failpoint 只属于测试构建/依赖注入。

### C# reference 与双向互通

固定 Di reference 为提交 `09f4e0816c1b2dc42461e79a968b46e811d3880c`；测试或审查时通过该 SHA 的 `git show`/只读 worktree，不能用会移动的 `migration/typescript-core` 分支作为旧行为证据。Pi reference 固定提交 `7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333`；其 [`session-manager.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/src/core/session-manager.ts)、[`load-entries.test.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/test/session-manager/load-entries.test.ts) 和 [`file-operations.test.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/test/session-manager/file-operations.test.ts) 已按该 commit 只读检查。Pi 对坏行采取尽力读取并跳过、为有效未换行 session 尾记录补 LF；Di checkpoint 需要保护工具副作用证据，迁移必须维持本文规定的 fail-closed 行为，不能把 Pi 的宽容解析作为恢复策略。

兼容测试应分三类：

1. Di writer fixture → TS reader，验证旧日志拒绝恢复、旧 audit 可供统计、checkpoint 能恢复；
2. TS writer → C# `SessionLog.LoadRecovery` 与现有 session 测试确认可读；
3. TS writer → TS reader round trip，并把双侧恢复出来的消息模型规范化比较。

现行 C# session tests 可在固定 SHA 上运行 `dotnet test Di.Tests/Di.Tests.csproj --filter FullyQualifiedName~Sessions` 作 reference check；实际是否执行由实现任务决定，本文未运行。C# writer 的 `session_meta.cli_version` 默认 0.1.0，而 reader 不以版本分支。不要以改 `cli_version` 宣称新 schema。若将来确需扩展 record/block，先定义明确 `schema_version` 和迁移矩阵；reader 对支持版本逐项校验，未知版本拒绝，不得把 unknown record 静默跳过。

## 平台 CI 蓝图（尚不存在）

仓库当前没有 tracked workflow。未来 CI 在 P0–P9 总计划指定的工具链/集成阶段创建，建议 Windows、macOS、Linux 三平台矩阵，Node 最低支持版本 22.19 与 24.x，执行 `npm ci`、typecheck、单元测试、本地 SSE 集成、build。首期版本固定建议从源 lock 已核实值出发：TypeScript `5.9.3`、`@types/node` `22.20.5`、`pi-tui` `1.2.0`；具体 workspace manifests 与 root lockfile 尚不存在，在相应阶段再提交。包 manager 为 npm workspaces，测试为 `node:test`，模块 ESM strict、TypeScript `noUncheckedIndexedAccess`、erasable TS；这些是已批准方案，不是当前仓库配置事实。

未来 workflow 结构草案（文件尚未创建，不能直接运行；action ref 为待核实 SHA 占位符，不代表已选版本）：

```yaml
name: TypeScript Core
on: [push, pull_request]
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, macos-latest, ubuntu-latest]
        node: ['22.19', '24']
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@<CHECKOUT_ACTION_SHA>
      - uses: actions/setup-node@<SETUP_NODE_ACTION_SHA>
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

这是 pipeline 形状提案，不是可复制即用的 workflow：实现者需核对 action pin 策略、Node 最低 patch 版本可用性、各 workspace scripts，并将 action pin 到仓库安全策略要求的版本/SHA。若最低 Node 22.19 无可用 runner，增加一个显式版本安装 smoke，而不是把 engine 声明悄悄提高。依赖更新必须更新 lockfile、在三平台跑完矩阵并检查 SSE/crash fixtures 未改变语义。

平台检查点：Windows 验证 CRLF 输入仍只按 LF JSONL framing、输出严格 UTF-8/no BOM、路径有空格/反斜线、子进程被强制终止后句柄释放；macOS/Linux 验证 chmod/executable packaging、shell 子进程退出、临时目录权限。session JSON 字段与换行应平台一致，cwd/path 是显式值不做 golden 固定。

## 安装、切换、用户数据与回退

迁移完成前保持 C# 旧分支/旧命令可运行。新包先使用架构文档确定的迁移命令 `di-ts`，不覆盖系统已有 `di`。旧、新实现测试用不同临时 `DI_HOME`；安装/升级脚本不能移动、删除、重写 `~/.di/config.json`、旧 session、skills、commands 或凭据。任何会覆盖现有配置的操作都不得作为自动 gate。

发布验收应留下可审阅证据：安装/卸载、默认/项目配置优先级、C# 与 TS 已知 session 子集双向 fixture、RPC/TUI 启动与持续交互、`--resume` 各模式组合、clear、ContextLimit、错误信息、SIGINT/进程结束与日志写入边界。provider 联网 smoke 不进 PR CI；如发布范围需要真实 provider 验证，使用隔离环境/账户、临时 `DI_HOME` 和受控 secrets，不复用或暴露个人/生产凭据。发布动作仍按用户已授权的范围执行；本文不新增额外批准流程。

建议迁移分支/工作区与基线分开：`migration/typescript-core` worktree 是可变的实现现场，只用于当前工作；review 基线始终用 pinned SHA 的 `git show` 或独立只读 worktree。切换失败时保留新 session 数据，启动旧 C# branch/worktree 继续工作；不要尝试用旧二进制恢复新 schema，除非双向测试明确证明该具体记录子集兼容。若转换工具后续出现，应先写新文件、完整校验并保留源文件，禁止原地覆写。

发布关卡采用逐步升级：先 CI 通过和本地隔离验收；再以新命令并行试用；完成 session/配置兼容和回退证据后再切换默认入口。本文未发布、未安装、未改默认命令，也没有运行尚不存在的 npm 脚本。

## 文档与实现交付条件

具体 session 格式与迁移单测来源见 [`sessions-and-compatibility.md`](sessions-and-compatibility.md)。发布前必须把所有“未来”标注替换为实际状态或保留明确的未实现说明；建立 workflow 后更新 `docs/README.md` 或总迁移索引入口（由文档 owner 决定）；新增命令只有落地后才记录为可执行。所有实现路径在目标代码存在后再写为 repo-root 相对路径并核实符号，不得让提案路径伪装成已存在文件。
