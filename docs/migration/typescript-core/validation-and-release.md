# TypeScript Core 验证与发布蓝图

> 状态：实施中，尚未完成发布验收。根 `package.json` 已提供 build/typecheck/test/test:compat，`.github/workflows/typescript-core.yml` 已定义三平台 Node 22.19/24 矩阵，但 workflow 配置不等于远端执行通过。实际验证证据见 [进度表](progress.md)；阶段与统一 gate 见 [`execution-plan.md`](execution-plan.md)。本文规范协议验证、兼容验收和切换风险控制。

## 验收原则

验收按用户可观察行为与数据安全语义做，不以 TS 测试数等于旧测试数作为目标。现有基线快照是 943 项 .NET 非集成测试、116 项 TUI 测试；它只描述一次验收，不是未来永久门槛。应逐项映射行为，补足旧测试未覆盖的跨进程损坏、双向格式兼容与平台差异。

TDD 每个工作单元遵循：先在目标 workspace 写 `node:test` 行为测试，运行确认失败且失败原因对应缺失行为；实现最小逻辑；重跑对应测试到绿；最后跑包级 typecheck/test。根 `package.json` 及各 workspace manifests 已提供 `npm test --workspace @di/coding-agent`、`npm run typecheck --workspace @di/coding-agent` 等命令；先构建跨包导出，再检查和测试。文档任务只验证受影响链接及事实；实现任务按变更执行对应 gate。

TS 与 C# 比较时规范化易变的 timestamp、cwd、随机 session id 和随机 turn id。不可规范化/抹去工具 `call_id`、`name`、原始 `arguments` 字符串、message ordering、record ordering、started/result 先后。对 JSON 对象字段顺序可按语义比较；另有 writer byte fixture 时再断言输出 key 顺序、UTF-8 和 LF。

## 分层测试计划

### 语言中立 fixture 与单元测试

在未来的 `packages/coding-agent/test/fixtures/sessions/` 存公开、不含凭据的 fixture：完整审计轮、完整 checkpoint 工具轮、多轮 history snapshot、assistant-only、started-only、completed、未知 record、未知 block、重复/孤立 call id、破损完整行、torn final line、legacy 审计文件。fixture 由 `Di.Tests/Sessions/SessionLogTests.cs` 已有断言整理，不手抄有噪音的时间和绝对路径。增加 manifest 写明期望结果和 fixture 来源提交 `09f4e0816c1b2dc42461e79a968b46e811d3880c`。

`node:test` 单测至少覆盖：envelope 顺序/ordinal、snake_case、UTF-8/no BOM、null 省略、audit 与 checkpoint 分离、checkpoint 读取/写入、工具调用参数逐字保存、每种 crash prefix、安全恢复与 fail closed、unknown 类型、坏行、历史 clear、ContextLimit。测试应直接检查模型 fake 收到的消息和 fake executor 调用记录。

每个 fixture 测试都从文件读取输入，不允许在测试内部调用 writer 生成被测输入再调用 reader 验收自身 round-trip 来替代固定 fixture。`manifest.json` 统一使用 [会话兼容契约](sessions-and-compatibility.md) 定义的字段名。例如 `started-no-completion.jsonl` 期望 `expected_status=reject_unknown_outcome`、`expected_error_mentions=["call-01"]`、`expected_model_calls=0`、`expected_executor_calls=0`、`expected_side_effect_count=0`；`assistant-before-start.jsonl` 期望恢复 user + assistant call + 合成 not-executed result；完整工具轮期望逐条列出角色、call id、arguments、结果文本。错误测试不能只断言 `assert.throws()`，还需断言 `expected_error_class`、行号或 call id，并断言没有发生模型请求和副作用。

### faux model / faux executor loop 测试

复用可控脚本模型返回确定的 assistant/tool-call/assistant 响应，不接外部服务。fake executor 记录开始与完成、call id/name/args、次数及可选磁盘 marker。注入每个持久化边界的故障，断言：started write 失败时工具完全没被调用；普通工具异常变为 `is_error=true` observation 并写 completed，随后可继续；取消 token 已取消且 started 后无 completed、或 completed 写失败，则执行结果未知，同 runner 后续调用被拒绝；completed 已写后模型再次失败，同进程继续使用保存结果且不重复副作用；不同 assistant batches 可复用相同 call id，但同一批重复不接受。模型 request 列表逐条按消息顺序比对。

另测 `/clear` 后新 checkpoint 写空 history，恢复后不复活 clear 前对话；普通新 turn 的 history 快照保留当时仍在内存中的旧消息并以其为恢复基底。`ContextLimit` 暂停保留原任务和已完成工具结果并可在扩大预算后继续。`--resume` 在新 runner 中载入同一历史、不会为恢复而先调用模型或重放工具；同时保持 `CliMode.Resolve` 行为：显式 `--mode` 优先，未指定时 positionals 仍选 print，随后才按 `--resume`/`--print`/TTY 推导默认模式。因此测试需覆盖 `--resume` 单独使用、与显式模式组合、与 positionals 组合，不能规定它总进入 REPL。这些测试对应 [会话兼容契约](sessions-and-compatibility.md) 中的现有 Di 测试矩阵。

### 本地 HTTP SSE 集成与真实进程崩溃

在未来 `packages/coding-agent/test/integration/` 用 Node 内建 HTTP server 仿 SSE provider，逐片返回固定响应/usage/异常，并把接收的 request body 保存到测试日志。它验证 provider adapter→loop→tool→session writer 的接线、stream 结束和错误路径，不需要真实模型、网络服务或 API key。测试必须实际启动目标 provider adapter，指向本机 server；只 mock `ChatModel` 不算 SSE 集成。server 需记录请求次数和完整 JSON body，并按固定分片边界发送真实 SSE framing；断言请求数为预期值、请求包含原始 user/tool history、事件顺序与 checkpoint JSONL 顺序一致、tool call id/name/arguments 原样对应、最终 result 与用量一致。另返回一次分片 JSON 错误/过早 EOF，断言该回合失败且 session 没写出虚假的 tool completed。临时监听回环地址并在 finally 关闭 server。

P5 在真实 session store 上做 child test host；这是独立测试入口，不冒充尚未实现的 production CLI。父测试创建新的临时根目录，把它通过 `DI_HOME` 传给子进程；子进程直接调用 session writer/reader 与测试用 loop host。子进程 stdout 发出阶段握手行后，父进程才执行 kill，避免靠 sleep 猜 race。每个 case 必须用全新子进程重新读取文件，并检查外部副作用 marker：

| case | 子进程操作顺序 | 父进程 kill/重启操作 | 强制预期 |
|---|---|---|---|
| started 尚未执行 | 写 turn start、assistant intent、`checkpoint_tool_started`；输出 `STARTED\n` 后等待 | 收到握手立即强制终止；再启动 recovery child | 文件有 started、无 completed；恢复报 unknown 且含 call id；executor 次数与副作用 marker 均为 0 |
| 副作用后结果未知 | 写 started；fake executor 先以 `wx` 创建唯一 marker（内容含 call id），再输出 `EFFECT\n` 并等待，尚未写 completed | 收到 `EFFECT` 后 kill；启动新的 recovery child | marker 存在、日志无 completed；恢复拒绝并含 call id；第二进程不得再次调用 executor，marker 创建次数仍为 1 |
| 完成结果后崩溃 | 写 started、创建 marker、写 completed 并重新读取确认 completed 行完整；输出 `COMPLETED\n` 后等待 | 收到握手后 kill；新进程 reload 并显式继续 | 恢复出同 call id 的唯一 tool result；executor 不再次执行，marker 次数仍为 1 |
| completed 写入失败 | fake executor 创建 marker 后，注入仅限测试的 writer 故障使 completed append 抛错 | 让子进程结束；在全新进程 reload/continue | started 存在而 completed 缺失；拒绝继续，marker 次数为 1。不能把异常转成普通工具 error observation，因为这里失败的是持久化结果 |
| 行尾撕裂 | 先写至少两条完整 LF 记录，再直接 append 一段无 LF 的 JSON 前缀并等待 | kill 子进程；新进程读取 | 只舍弃尾部片段，返回此前完整状态；若把相同片段补 LF，必须报坏行和精确物理行号 |

P7/P9 的真实 CLI gate 另用已启动的 production `di-ts --resume <fixture>`（命令名按架构文档）和明确模式组合运行；一个 host test harness 通过不代表 CLI/RPC/TUI 已通过。实测至少覆盖默认交互、`--mode json`、`--mode rpc`、`--print`、带 positional prompt、legacy/损坏输入；检查实际 exit code、stdout/stderr、RPC result 数、model 请求数及 executor marker。无效 session 必须在模型请求前退出。所有崩溃测试要断言子进程未运行正常 `finally` 清理（可用“正常退出才创建”的 sentinel），并核对退出码/信号；不能用同进程 throw、mock recovery 或 `process.exit()` 正常结束冒充 kill。父进程需设超时、收集 stdout/stderr、释放 server/子进程并清理 temp root。Windows 强制终止行为及文件句柄释放需在 Windows runner 实测，不能由 POSIX 结果推断。

各层 gate 不互相替代：固定 fixture 单测验证状态机；P5 child host 验证真实进程/文件边界；本地 SSE 集成验证真实 provider adapter；C# harness 验证跨语言读取；P7/P9 验证实际 CLI/RPC/TUI 接线；10 小时 soak 验证实际墙钟期间资源曲线。一个 TS 内的 mock-to-mock、一次 `npm test` 绿、短时快循环或单一平台通过，都不得在报告中折算成上述其他 gate 的通过。每个 gate 报告应列出 fixture 名/提交、命令、退出码、OS/Node、关键断言、失败与未执行项；未执行必须保留为未通过/待验证，不能默认为通过。

### 十小时持续运行与资源观察

10 小时是实际墙钟 soak gate，不是快速 fake loop 的等价次数。使用隔离机器、临时 `DI_HOME`、本地确定性 fake model 和 fake tool；执行至少 10 小时并记录实际起止 UTC。每次模型响应与工具执行可按稳定节奏加入真实延时，但不从延时间隔推导最低完成轮数。不得接真实 provider。循环中让模型/工具有限产生并结束子进程，定期真实 resume/reload 子进程，并记录 checkpoint 文件 bytes/lines、成功/失败 turn、内存 RSS、打开文件/句柄数、子进程数量和重启耗时。保留 machine/OS/Node 版本、采样 CSV、JSONL、退出码及异常日志作为 gate artifact。

当前 [soak runner](../../../packages/coding-agent/test/soak/soak-runner.mjs) 保留 `handle_count` 字段供既有 checker 读取；它来自 Node `process._getActiveHandles()`，只代表 JS 活跃句柄，不能当作 OS handle 数。旁边的 [process sampler](../../../packages/coding-agent/test/soak/process-metrics.mjs) 记录 `js_handle_count`、`os_handle_count`、working set、peak working set、private bytes，以及 V8 `total_heap_size` / `total_physical_size` / `malloced_memory` / `peak_malloced_memory`。Windows 使用 `GetProcessMemoryInfo` / `GetProcessHandleCount`，Linux 使用 `/proc`，macOS 使用 `/usr/lib/libproc.dylib` 的 `proc_pidinfo` 读取文件描述符数和 `pti_resident_size`，不推测 macOS peak/private 值。Apple [`libproc.h`](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.h) 将接口标为可能变化的 private interface；[`proc_info.h`](https://github.com/apple/darwin-xnu/blob/main/bsd/sys/proc_info.h) 定义 flavor 和结构布局。调用失败时记录 `null` 和不含环境细节的错误标记，不用 JS 句柄数代替 OS 数值。Windows 的 `private_bytes` 来自 `PROCESS_MEMORY_COUNTERS_EX.PrivateUsage`（进程私有提交量），Linux 来自 `smaps_rollup` 的私有常驻页；两种口径不可直接横向比较。对应覆盖见 `packages/coding-agent/test/compat/soak-process-metrics.test.mjs` 与 `packages/coding-agent/test/compat/soak-supervisor.test.mjs`。

soak 使用现有有限 context/token budget 配置，避免测试因为无界历史输入而要求无界内存；按已有 `ContextLimit` 语义安排暂停和扩预算续跑，另按已有 reset/clear 接口周期性验证 clear 后 history 快照行为。不要新增自动摘要、隐式清理或别的产品功能来让 soak 变绿。session 文件随持久化事件增长是预期；常驻 runner memory 应按配置预算和当前 pause task 解释，不能要求它在无限历史下固定不变。子进程/句柄在每轮收尾后应回到稳定基线附近。

资源阈值必须在 soak 开始前冻结到测试 manifest：先在同一 OS/Node/机器等级跑至少 30 分钟 warm-up，选定并记录 `rss_max_delta_bytes`、`handle_max_delta`、`child_process_max`、`resume_p95_max_ms` 和采样间隔；若 manifest 明确提供 `os_handle_max_delta`，checker 还会验证全程 `os_handle_count` 峰值增长，任何缺失或 `null` 样本均失败；旧 manifest 未配置该阈值时不报告该 gate 通过。阈值与 baseline JSON/CSV 一同提交或作为不可变 CI artifact 引用，跑完后不得按结果回调阈值。若 10 小时中 RSS 超限、多个采样窗口单调增长、句柄数不回落、子进程残留、失败/恢复错误递增或 resume 延迟超限，gate 失败并保留数据定位。阈值用于发现回归，不证明零泄漏或零风险；最终报告附实际曲线和偏差。soak 不属于每次 PR 快测，可由夜间/发布候选运行，但 P9 完成证据必须引用真实墙钟至少 10 小时结果；快速循环只补充状态覆盖，不能替代 soak，也不以轮数推算时长。

至少在每个受支持 OS 各运行一次完整 10 小时 soak。测试期间记录实际起止 UTC，不从迭代数估算时长；若资源曲线越过预先冻结阈值，需定位、修复并用新 run id 重跑，不得只以机器差异豁免。

### C# reference 与双向互通

固定 Di reference 为提交 `09f4e0816c1b2dc42461e79a968b46e811d3880c`；测试或审查时通过该 SHA 的 `git show`/只读 worktree，不能用会移动的 `migration/typescript-core` 分支作为旧行为证据。Pi reference 固定提交 `7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333`；其 [`session-manager.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/src/core/session-manager.ts)、[`load-entries.test.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/test/session-manager/load-entries.test.ts) 和 [`file-operations.test.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/test/session-manager/file-operations.test.ts) 已按该 commit 只读检查。Pi 对坏行采取尽力读取并跳过、为有效未换行 session 尾记录补 LF；Di checkpoint 需要保护工具副作用证据，迁移必须维持本文规定的 fail-closed 行为，不能把 Pi 的宽容解析作为恢复策略。

兼容测试应分三类：

1. Di writer fixture → TS reader，验证旧日志拒绝恢复、旧 audit 可供统计、checkpoint 能恢复；
2. TS writer → C# `SessionLog.LoadRecovery` 与现有 session 测试确认可读；
3. TS writer → TS reader round trip，并把双侧恢复出来的消息模型规范化比较。

现行 C# session tests 可在固定 SHA 上运行 `dotnet test Di.Tests/Di.Tests.csproj --filter FullyQualifiedName~Sessions` 作 reference check；实际是否执行由实现任务决定，本文未运行。C# writer 的 `session_meta.cli_version` 默认 0.1.0，而 reader 不以版本分支。不要以改 `cli_version` 宣称新 schema。若将来确需扩展 record/block，先定义明确 `schema_version` 和迁移矩阵；reader 对支持版本逐项校验，未知版本拒绝，不得把 unknown record 静默跳过。

上面的现有 C# 测试本身不读取 TS 本轮生成的任意临时文件，因此仅运行这条 `dotnet test` 不能证明 TS→C#。P5 需用独立 C# reference harness 做实际交叉读取，避免 TS writer/reader 自测：

1. 测试脚本在 OS 临时目录生成临时 SDK project，`ProjectReference` 指向固定 checkout 的 `Core/Core.csproj`，不改 Di tracked source。生成的 harness 有两个明确操作：`write <root>` 用真实 `SessionLog`、`BeginCheckpointTurn`、`AppendCheckpointMessage`、`CheckpointToolStarted`、`CheckpointToolCompleted` 写一条已知工具轮并将实际日志完整路径输出；`read <file>` 用真实 `SessionLog.LoadRecovery` 读取并断言 user text、assistant tool call id/name/原始 arguments、tool result call id/text/is_error，任一不符非零退出。
2. **C#→TS：**执行 harness `write` 取得它实际写出的 JSONL；把该路径作为 TS parser 输入；断言规范化消息数组逐项等于 fixture manifest。TS 不能重写输入文件（比较读取前后 SHA-256）。
3. **TS→C#：**由独立 TS writer 写完整 known-subset fixture；执行 harness `read <file>`；断言进程零退出，并从 harness 的逐消息 canonical stdout 与 manifest 精确比较。不得只以 C# parser“不抛异常”作通过条件。
4. **负例：**向 TS 输出文件加 unknown checkpoint type 或删掉 completed；C# reader 对首期已知子集内损坏必须拒绝 unknown outcome/无效结构；TS 自身也必须拒绝 unknown checkpoint。此处只断言 09f4e08 C# reader 实际能表达的错误，不要求旧 C# 拒绝它当前静默忽略的未知顶层 record；该已知缺口由 TS fail-closed gate 单独拦截。

命令模板（路径和测试 harness 均为未来测试脚本生成，不能在当前仓库直接运行）：

```powershell
$env:DI_HOME = Join-Path $env:TEMP 'di-ts-csharp-compat'
dotnet run --project <temp-harness>/Reference.csproj -- write $env:DI_HOME
# 将上条 stdout 的 JSONL 路径传给 TS fixture reader；再由 TS writer 生成另一份文件：
dotnet run --project <temp-harness>/Reference.csproj -- read <ts-writer-session.jsonl>
```

实际脚本需保存两侧 stdout/stderr、退出码、JSONL、hash 前后值与规范化消息 diff；如果 `dotnet` 不存在则 compatibility gate 标为未执行/阻塞该发布门槛，不能跳过后报告整体通过。`Core/Core.csproj` 是 Di 基线中已核实存在的项目路径。

## 平台 CI：实际执行范围

唯一配置来源是 `.github/workflows/typescript-core.yml` 的 `verify` job。push 或 pull_request 触发 Windows、macOS、Ubuntu × Node 22.19.0 / 24，共六个独立任务；`fail-fast: false` 保留所有平台的结果。Actions 自身使用 Node 24 运行时，测试使用各矩阵指定的 Node 版本。

| 步骤 | 实际命令 / 验证范围 |
|---|---|
| 获取源码与工具链 | 完整 Git 历史（C# harness 需要固定基线），矩阵 Node，以及仅供兼容测试使用的 .NET 10 SDK |
| 安装锁定依赖 | `npm ci`，使用根 `package-lock.json` |
| 构建 | `npm run build`，先生成依赖 workspace 的 JS / `.d.ts` |
| 类型检查 | `npm run typecheck` |
| 平台 shell 前提 | Windows 验证 `powershell.exe`，POSIX 验证 `pwsh`；CI 缺少必需 shell 会报错 |
| 单元测试 | 先验证 CI runner 自身，再由 `node tools/run-ci-unit-tests.mjs` 调用 `npm run test --workspaces --if-present`；运行原 TUI、`@di/agent`、`@di/ai`、`@di/coding-agent` 的测试，复用已构建产物 |
| 兼容测试 | `npm run test:compat`，运行 `packages/coding-agent/test/compat/` 中的 C# 双向会话互读、两个 provider 的本地 SSE → loop → session、坏流、大日志与 UTF-8 恢复、长测工具自身检查 |
| 留存证据 | job summary 区分各检查结果，`test-logs-<OS>-node-<version>` artifact 保存 unit / compat 日志 |

兼容测试在构建成功且任务未取消时独立执行，即使单元测试失败也保留兼容性证据；任一测试失败仍使整个 job 失败。首次运行 39717236044 使用旧的默认步骤条件，六个 unit 均失败，因而 compat 全部 skipped；不能把安装 .NET SDK 当成已经执行 C# 互读验收。具体运行结果保存在 [进度表](progress.md)。

`packages/coding-agent/package.json` 的单测命令设置 `--test-timeout=120000`，使挂起的测试在两分钟后报告失败。该 Node 选项不能单独清理残留句柄，因此 `tools/run-ci-unit-tests.mjs` 的 `runCiUnitTests` 另设八分钟总体上限，超时终止测试进程树并返回失败，以保留日志和后续兼容测试机会。`packages/coding-agent/test/compat/csharp-session-interop.mjs` 解包固定 C# 基线时以目标目录作为子进程 `cwd`，不向 GNU tar 传入 Windows 绝对路径 `-C`；Windows CI 的 Git Bash 与本地系统 tar 都需要支持。

所有自动用例使用合成凭据、临时目录与 loopback 服务。unit 包括三平台的隔离安装与显式入口切换/回退；真实 provider smoke、35 分钟预热及 10 小时长测、向真实用户目录安装、部署和真实用户默认 `di` 入口切换不在该 workflow 中。compat 中的 soak supervisor 测试仅验证启动、状态和来源记录，不等于完成 10 小时稳定性验收。

工具链版本以 workspace manifests 与根锁文件为准。Action pin 使用已核实的发布 SHA，依赖更新需重跑三平台矩阵并检查 SSE/crash fixtures 未改变语义。

平台检查点：Windows 验证 CRLF 输入仍只按 LF JSONL framing、输出严格 UTF-8/no BOM、路径有空格/反斜线、子进程被强制终止后句柄释放；macOS/Linux 验证 chmod/executable packaging、shell 子进程退出、临时目录权限。session JSON 字段与换行应平台一致，cwd/path 是显式值不做 golden 固定。

## 安装、切换、用户数据与回退

迁移完成前保持 C# 旧分支/旧命令可运行。新包先使用架构文档确定的迁移命令 `di-ts`，不覆盖系统已有 `di`。旧、新实现测试用不同临时 `DI_HOME`；安装/升级脚本不能移动、删除、重写 `~/.di/config.json`、旧 session、skills、commands 或凭据。任何会覆盖现有配置的操作都不得作为自动 gate。

发布验收应留下可审阅证据：安装/卸载、默认/项目配置优先级、C# 与 TS 已知 session 子集双向 fixture、RPC/TUI 启动与持续交互、`--resume` 各模式组合、clear、ContextLimit、错误信息、SIGINT/进程结束与日志写入边界。provider 联网 smoke 不进 PR CI；如发布范围需要真实 provider 验证，使用隔离环境/账户、临时 `DI_HOME` 和受控 secrets，不复用或暴露个人/生产凭据。发布动作仍按用户已授权的范围执行；本文不新增额外批准流程。

建议迁移分支/工作区与基线分开：`migration/typescript-core` worktree 是可变的实现现场，只用于当前工作；review 基线始终用 pinned SHA 的 `git show` 或独立只读 worktree。切换失败时保留新 session 数据，启动旧 C# branch/worktree 继续工作；不要尝试用旧二进制恢复新 schema，除非双向测试明确证明该具体记录子集兼容。若转换工具后续出现，应先写新文件、完整校验并保留源文件，禁止原地覆写。

发布关卡采用逐步升级：先 CI 通过和本地隔离验收；再以新命令并行试用；完成 session/配置兼容和回退证据后再切换默认入口。`install.ps1` 当前安装并行命令 `di-ts`，保留既有 C# `di`；CI 不自动安装到用户目录或切换默认入口。

`install.ps1` 使用当前平台的 npm，POSIX 需 `pwsh`，会为 `di-ts` 设置执行权限、实际运行该 shim 的 `--info`，并打印 PATH 指令而不修改 shell profile。smoke 的临时 `DI_HOME` 和 API 环境变量结束后恢复原值。`packages/coding-agent/test/cli/install-runtime.test.ts` 验证安装的私有运行时、原生依赖和既有用户文件字节保留。

已并行安装 TS 和旧 C# 启动器时，可显式使用 `tools/select-cli.ps1 -Runtime typescript|csharp -DiHome <目录>` 验证切换。工具仅管理显式目录的 `bin`，将原 C# 启动器保留在同目录的 `di-csharp.exe` / `di-csharp`，以 `.di-cli-selection.json` 的 SHA256 检查拥有的 shim 和备份；回退恢复原始文件并保留 `di-ts`。备份冲突、优先级启动器冲突、内容变动或未归属 shim 均拒绝覆盖。此工具不替代发布门槛，也不处理 shell 函数/alias 或其他 PATH 目录中的同名命令。隔离测试见 `packages/coding-agent/test/cli/select-cli.test.ts`；现有 Windows 单文件 C# 发行物已做复制、改名运行、TS 调用及恢复后的真实进程演练，其他 apphost 布局需独立验证。

## 文档与实现交付条件

具体 session 格式与迁移单测来源见 [`sessions-and-compatibility.md`](sessions-and-compatibility.md)。发布前必须把所有“未来”标注替换为实际状态或保留明确的未实现说明；建立 workflow 后更新 `docs/README.md` 或总迁移索引入口（由文档 owner 决定）；新增命令只有落地后才记录为可执行。所有实现路径在目标代码存在后再写为 repo-root 相对路径并核实符号，不得让提案路径伪装成已存在文件。
