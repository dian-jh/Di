# P4-win-process-probe：Windows 子孙进程树终止与管道清理预研

> 状态：预研结论（PRE-RESEARCH）。任务 ID `P4-win-process-probe`，对应
> [operator-guide.md](../operator-guide.md) 预研表与本仓库子进程契约
> [tools-and-platform.md §子进程：one-shot 超时、取消、输出和树终止](../tools-and-platform.md)。
> 固定 C# 基线 `09f4e08`；旧源码一律经 `git show 09f4e08:<path>` 读取。
> 本页只记录证据与选型，不接入主流程、不提交任何代码。
>
> 测试机：Windows 11 Enterprise 10.0.26100（win32），Node `v24.16.0`。
> 探测脚本在仓库外临时目录运行（`$TMPDIR/p4-win-process-probe`），未进入 git 工作区。

## 结论速览

- **Windows 上树终止的可用基线是 `taskkill /PID <pid> /T /F`，实测定可杀整棵进程树**
  （含孙进程与 conhost），exit 0，耗时约 1.6–3.0s；杀后整树枚举为空、无残留。这是迁移文档默认
  基线的真实复现证据。
- **`child.kill('SIGKILL')` 只杀直接父进程**：孙进程成为孤儿继续运行并**持有 stdout/stderr
  pipe 写端**，导致读循环永不 EOF、`close` 永不触发——正是 C# `DrainTimeoutMs` 要防的挂死。
  实测 parent-only kill 后 `close` 在 3s 截止内从不触发。
- **Windows `detached:true` 不提供 POSIX process-group 信号语义**：`process.kill(-pid, ...)`
  抛 `ESRCH`（errno -4040），杀不掉任何东西。不能把 POSIX 组杀写法搬到 Windows。
- **PowerShell `Stop-Process -Id x -Force` 也只杀单个进程**，孙进程同样孤儿化；不是树终止手段。
- **推荐终止顺序：先杀树、后等管道**。`taskkill /T /F` 杀光整树后，pipe 写端随之关闭，
  `close` 在树死后 0–15ms 内触发（实测 after-kill 1.65–2.97s，其中大部分是 taskkill 自身耗时，
  与 C# 的「先 Kill 再 drain」一致）。反之，只杀父进程后管道仍开着，必须先枚举并杀残留后代。
- **取消/超时路径**：AbortSignal 触发后执行同一套 taskkill → await `close`（有界截止）→
  有界排干。实测取消后整树死、`close` 正常、无孙进程遗留。
- **已退出竞态**：进程自然退出后再 taskkill 返回 exit 128「没有找到进程」，属良性，跳过即可；
  `exit`/`end`/`close` 监听必须从 spawn 起就挂（事后挂会漏事件）。
- **平台坑**：taskkill 的 stdout 是系统 OEM 字节（本机 GBK 乱码）——只查退出码、忽略正文；
  Git Bash 会把 `/PID` 路径化（MSYS），但 Node `spawn` 传 argv 数组不受影响；每棵控制台进程树
  都带一个 `conhost.exe` 后代，枚举时必须容忍；孤儿进程的 PPID 仍指向已死父进程，可据此枚举。

## 1. 候选机制对照（真实树上的实测）

统一实验树：`probe(Node) → TOP cmd.exe → powershell.exe → PING.EXE(ping -n 240 127.0.0.1)`，
另带 `conhost.exe`（控制台宿主，每棵控制台树都有）。枚举经 `Get-CimInstance Win32_Process`
按 ParentProcessId 建树（完整快照实测约 2.7s，仅用于验证，不进生产路径）。

| 机制 | 杀树？ | exit/结果 | 残留 | 耗时 | 结论 |
|---|---|---|---|---|---|
| `taskkill /PID <top> /T /F` | **是（全树）** | 0；stdout 逐条列「已终止 PID…」 | **无** | 1.6–3.0s | **采用** |
| `process.kill(top,'SIGKILL')`（仅父） | 否 | 返回 true（已发送） | powershell+PING+conhost 全活（孤儿） | 0ms | 弃用 |
| `spawn({detached:true})` + `process.kill(-top,…)` | 否 | 抛 `ESRCH`（errno -4040） | 整树原样存活 | 0ms | 弃用（Windows 无组语义） |
| PowerShell `Stop-Process -Id top -Force` | 否 | 0（cmdlet，无树） | powershell+PING+conhost 全活（孤儿） | 1.6s | 弃用 |

taskkill 实测正文（本机 OEM/GBK，UTF-8 终端里是乱码，只认退出码）：
`成功: 已终止 PID 100856 (属于 PID 18668 子进程)的进程。` 等四条，覆盖 PING/powershell/conhost/TOP。

### 证据 A：`taskkill /T /F` 杀全树

```
TOP=105104；树：105104 cmd → 18668 powershell → 100856 PING；105104 → 104592 conhost
taskkill /PID 105104 /T /F   → exit 0，elapsed 2270ms，列出终止 100856/104592/18668/105104
杀后树枚举：pid=105104 (NOT FOUND — dead)；全表扫描无 105104/18668/100856/104592
```

### 证据 B：`process.kill(top,'SIGKILL')` 只杀父、孙孤儿化

```
树：2544 cmd → 3352 powershell → 99600 PING；2544 → 59196 conhost
process.kill(2544,'SIGKILL') → 返回 true（0ms）
杀后：2544 死；3352、99600、59196 全部存活，PPID 仍指向已死的 2544
probe 进程在 5s 后仍存活（管道被孤儿持有 → 读循环不 EOF）；
杀光孤儿子树后管道关闭、probe 才退出 —— 管道挂死机制实锤
```

### 证据 C：Windows `detached:true` 无组信号

```
detached 树：36440 cmd → 93896 powershell → conhost + 107116 PING
process.kill(-36440,'SIGTERM') → 抛 ESRCH（"kill ESRCH"）
process.kill(-36440,'SIGKILL') → 抛 ESRCH
杀后：整树原样存活。Windows detached 只表示「父退子续」，不提供组信号
```

### 证据 D：`Stop-Process` 无树语义

```
树：107228 cmd → 31088 powershell → 97564 PING；107228 → 106592 conhost
Stop-Process -Id 107228 -Force → exit 0，elapsed 1569ms
杀后：107228 死；31088、97564、106592 全部存活（孤儿）
```

## 2. 推荐的树终止：`taskkill /PID <pid> /T /F`（含时序证据）

8 次独立取消实验（`probe_cancel.mjs <delay> tree [shape]`），树形含 ping / 静默 node
sleeper / cmd→cmd 链，AbortSignal 在 0.8–5s 触发，taskkill 后 await `close`（截止 3000ms）：

| run | delay/shape | taskkill exit | taskkill 耗时 | close after-kill | exit→close 间隔 | 残留 |
|---|---|---|---|---|---|---|
| a | 1500 / ping | 0 | 2968ms | 2964ms | 1ms | 无 |
| b | 3000 / ping | 0 | 1911ms | 1910ms | 2ms | 无 |
| c | 1500 / quiet | 0 | 1732ms | 1739ms | 12ms | 无 |
| d | 1500 / cmdcmd | 0 | 2154ms | 2148ms | 0ms | 无 |
| e | 1500 / ping | 0 | 1864ms | 1865ms | 3ms | 无 |
| f | 1500 / ping | 0 | 2173ms | 2171ms | 4ms | 无 |
| g | 800 / ping | 0 | ~1734ms | 1734ms | 5ms | 无 |
| h | 5000 / ping | 0 | ~2363ms | 2363ms | 4ms | 无 |

- `close`（= 进程退出且两条 stdio 全部关闭）在树死后 0–15ms 内到达：**杀树即关管道，排干顺带完成**。
- taskkill 自身耗时波动大（1.6–3.0s）。分解实测：Node spawn 开销仅 80–165ms；`taskkill /T`
  对不存在 PID 也要约 1.59s（不带 `/T` 约 0.56s）——`/T` 旗标本身的树枚举就是大头。
  ⇒ `close` 截止建议 **5s**（3s 有一次跑到 2.97s，太紧）。

## 3. 取消/超时清理记录（AbortSignal → 杀树 → 排干）

`probe_cancel.mjs 2000 tree`（推荐路径，一次完整回放）：

```
spawned top pid=19956；树：19956 cmd → 103848 conhost + 55344 powershell → 107040 PING
abort at +2005ms — starting kill phase
taskkill exit=0 elapsed=1650ms（终止 107040/103848/55344/19956 四条）
close-event result: {"ok":true,"close":{"c":1,"s":null},"afterKillMs":1648}（截止 3000ms）
TREE AFTER KILL: pid=19956 (NOT FOUND — dead)      ← 无孙进程遗留
SUMMARY: exit c=1 → close c=1（间隔 3ms）
buffers: stdout_total=337 字节（有界 ring 全收），stderr=0
```

`probe_cancel.mjs 2000 parent`（对照：只杀父进程，证明挂死 + 清理困境）：

```
parent-only kill sent elapsed=0ms
close-event result: {"timedOut":true,"close":null,"afterKillMs":3000}   ← close 永不触发
TREE AFTER KILL: powershell/PING/conhost 全活（孤儿）
CLEANUP: taskkill /PID <已死 top> /T /F → exit 128 "没有找到进程"      ← 经死父 PID 够不到孤儿
必须逐个枚举存活后代（PPID==死父）再 taskkill 才清干净
```

## 4. 已退出竞态（自然退出后 taskkill）

`probe_race.mjs`：短命树 `cmd /c ping -n 3 127.0.0.1`（约 2s 自然退出），taskkill 延后到 3.5/5s。

- `exit`(c=0) / `stdout end` / `close` 在自然退出点同时触发（连续监听，非事后挂）。
- 之后 `taskkill /PID <已死top> /T /F` → exit 128「没有找到进程」，**良性**，无需报错，跳过即可。
- 无残留。⇒ 实现必须区分：`child.exitCode != null`（已退出）时 kill 可省或容忍 128。

## 5. 管道清理顺序（先杀树、后排干）

`probe_order.mjs`（病理场景：父 cmd 已退、`start /b ping` 后代持有管道）：

```
exit fired at +126ms code=0
after 1500ms post-exit: close=null（管道仍被 start /b ping 持有 → 无截止必挂死）
taskkill /PID <死父> /T /F → exit 128（经死父 PID 够不到持有者）
CIM 枚举 ParentProcessId == <死父> → [92772, 107044]（ping + conhost）
逐个 taskkill → close 触发；期间 stdout 字节从 154 涨到 644（管道一直活着）
```

结论与顺序：

1. **超时/取消（父进程通常还活着）**：`taskkill /T /F` 根 PID → await `close`（5s 截止）
   → 有界排干（ring 头 6000/尾 18000）。树死则管道自动 EOF，排干随 `close` 完成。
2. **自然退出**：await `exit` → await `close`（1s 截止，对应 C# `DrainTimeoutMs=1000`）。
   若 1s 内未 `close`（后代持有管道）：停读、关读端、返回 partial output，**不得无限等**。
   （可选改进，超 C# 现状：枚举 `ParentProcessId==topPid` 并逐个 taskkill 回收持有者。）
3. **只杀父进程是错误顺序**：管道会被孤儿持有，读循环挂死，且事后经死父 PID 无法 taskkill
   到孤儿，清理成本更高。

## 6. 平台坑（Windows 实测）

- **taskkill 输出是 OEM/GBK 字节**：UTF-8 终端看是乱码。实现只检查 `exit code`，忽略 stdout/stderr
  （可用 `stdio:['ignore','ignore','ignore']`）。
- **Git Bash/MSYS 会路径化 `/PID`**（`D:/software/Git/PID`）。Node `spawn('taskkill', ['/PID',…])`
  传 argv 数组不受影响；只有经 shell 字符串调用才会踩坑。
- **每棵控制台进程树都带 `conhost.exe` 后代**（`windowsHide:true` 也生成）。`taskkill /T` 会连它
  一起杀，无害；后代枚举必须容忍/忽略它。
- **孤儿进程的 PPID 仍指向已死父进程**：树死后用 `ParentProcessId == 已死topPid` 仍能枚举到残留
  后代（实验 5 据此回收持有者）。
- **`start /b` 与 `Start-Process -NoNewWindow` 后代继承父 stdout 管道**，父退后仍持写端——
  这是「有孙进程继承 pipe」挂死的真实来源。
- **Node `close` = 退出 + 全部 stdio 关闭**，是最强「管道清完」信号；但监听必须从 spawn 起挂，
  事后挂会漏事件（`probe_race` 首版即踩）。`exit` 单独不够（父退管道可能仍开）。
- **`child.kill()` 在 Windows = `TerminateProcess(单 PID)`**，无树语义；`kill(-pid)` 抛 `ESRCH`。
- **taskkill `/T` 旗标本体约 1s 开销**（即使目标不存在）；CIM 全表快照约 2.7s——两者都不进
  生产热路径，`无孙进程遗留` 的验收断言放测试侧做。

## 7. 对 TS 实现的建议（process-runner.ts，Windows 侧）

1. `spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide:true, stdio:['ignore','ignore','ignore'] })`；
   以参数数组传，不拼 shell 字符串；`exit code 0` = 树已杀，`128` = 已退出/不存在（良性竞态），
   其余非零码记诊断。
2. 超时/取消统一走：**杀树 → await `close`（5s 截止）→ 有界排干**；外部取消抛取消语义，
   超时返回 `error:` + 有界 partial。`close` 未在截止内到（异常残留）也要关读端、不挂死。
3. 自然退出：`exit` 后 await `close`（1s 截止，对齐 C# `DrainTimeoutMs`），超时则停读返回 partial。
4. `exit`/`close`/`end` 监听 spawn 时即挂；PID 记录在案以区分已退出竞态。
5. Windows tree-kill 适配层 = taskkill（本探针已验证）；若部署策略禁用 taskkill 或验证失败，
   再按 operator-guide 走显式 Job Object 原生 API 决策，不得静默回退 `child.kill()`。
   （Job Object 需原生小适配层，本探针未做，属后续显式决策项。）
6. POSIX 侧才用 `detached:true` + `process.kill(-pid, 'SIGTERM')` 宽限后 `SIGKILL`；两种平台分别
   集成验收，本探针只覆盖 Windows。

## 8. 探测脚本（仓库外 `$TMPDIR/p4-win-process-probe`，可复现）

| 脚本 | 用途 |
|---|---|
| `spawn_tree.mjs <pidfile> <shape>` | 生成树：`ping`/`quiet`/`cmdcmd`，写 TOP PID，持管道 |
| `ps_tree.mjs <rootPid>` | CIM 枚举 + ParentProcessId 建树打印（验证用） |
| `probe_taskkill.mjs <pid>` | 机制 A：`taskkill /T /F` |
| `probe_sigkill.mjs <pid>` | 机制 B：`process.kill(pid,'SIGKILL')` |
| `probe_detached.mjs spawn\|kill` | 机制 C：detached + `kill(-pid)` |
| `probe_stopprocess.mjs <pid>` | 机制 D：`Stop-Process -Force` |
| `probe_cancel.mjs <delay> tree\|parent [shape]` | 集成取消/超时 + close 时序 + 残留验证 |
| `probe_race.mjs <delay>` | 已退出竞态（taskkill 128 良性） |
| `probe_order.mjs showhang` | 父退孙持管道 + 死父 PID 清理困境 |
| `sleeper.mjs` | 静默长跑（90s exit 7） |
