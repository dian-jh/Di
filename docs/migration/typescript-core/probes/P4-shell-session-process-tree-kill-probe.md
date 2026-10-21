# P4-shell-session-process-tree-kill-probe：已实现 TS 路径的 Windows 进程树 kill 实测

> 状态：实现验收实测（ACCEPTANCE，对已提交的 TS 实现代码路径）。任务 ID
> `P4-shell-session-powershell-python`，对应契约
> [tools-and-platform.md §子进程：one-shot 超时、取消、输出和树终止](../tools-and-platform.md)
> 与本卡验收项「Windows 进程树 kill 必须实测记录」。
> 预研基线见 [P4-win-process-probe.md](./P4-win-process-probe.md)（`taskkill /PID <pid> /T /F`
> 的选型证据，本页是对已实现路径的复现测量，不再重复机制对比）。
>
> 测试机：Windows 11 Enterprise 10.0.26100（win32），Node `v24.16.0`。
> 探测脚本 `probe-ptk.ts`（仓库外临时目录，未进入 git 工作区；对已实现源码的
> `dist` 产物执行：`ShellSession` / `powershellSessionShell` / `killProcessTree`）。

## 结论速览

- **`ShellSession.dispose()` 的整树终止实测成立**：fire-and-forget 返回仅 21ms；
  杀后直系 python 与孙 python **全部消失**（本轮实测 2946ms / 794ms 内退净），
  无孤儿残留。孙进程（父已随树而死）同样被清，证明 `taskkill /T` 杀的是整棵树，
  而非仅直接子进程。
- **超时路径（会话自愈）同样杀整树**：2s 预算触发后，会话进程连同其后台
  `Start-Process` 派生的 python 孙树全部退出，下一次调用自动重建并正常返回
  `exit: 0`（自愈验收通过）。
- **`killProcessTree()` 直接 API**：对 live 子进程单次调用 2447ms 返回，进程确认消失。
- **测量方式**：进程存在性用 `tasklist /FI "PID eq <pid>" /NH` 的**输出**判定
  （行内含独立 PID token），**不是**退出码——本机 `tasklist` 对「无匹配进程」也返回
  exit 0（只打印 GBK 编码的「信息: 没有运行的任务匹配指定标准。」），退出码判活会
  恒判「活着」。这是本探测踩出的新坑，已在下方记录。
- **新平台坑：cmd `start /b python -c "…"` 在本机不执行代码**（launch 的 python 进程
  存在但脚本不跑，疑似 Microsoft Store `WindowsApps\python.exe` 占位 stub 经 `start`
  解析后的行为；`start /b cmd /c echo` 与直跑 `python -c` 均正常）。探测改用
  PowerShell `Start-Process python -ArgumentList '<脚本>'`（返回立即、子进程留在会话
  进程树内）派生孙树。

## 探测设计（如何测的）

统一实验树（会话内）：`powershell.exe(会话) → python(pid1) → python(pid2 孙进程)`。
`sleeper.py` 让 pid1 用 `subprocess.Popen` 派生 pid2、把两个 PID 写入 pidfile、
然后 `time.sleep(120)` 长跑持管道。树形经 `Get-CimInstance Win32_Process` 的
ParentProcessId 验证（ppid(pid2) == pid1）。杀后每 150ms 用 tasklist 输出判定两个
PID 是否仍在进程表中（15s 截止）。

| 场景 | 触发 | 断言 |
|---|---|---|
| A `dispose()` | `session.dispose()`（fire-and-forget taskkill） | pid1、pid2 全部消失 |
| B 超时自愈 | `execute(..., 2000)` 触发会话终止 | pid1、pid2 消失；下次调用 `exit: 0` |
| C 直接 API | `await killProcessTree(child)` | 单进程消失 |

## 实测记录（2026-10-21，Windows 11 Enterprise 10.0.26100，Node v24.16.0）

### 证据 A：`ShellSession.dispose()` 杀整树（含孙进程）

```
会话命令返回：exit: 0（Start-Process 立即返回，孙树留在后台）
树：python(pid1=126236) ppid=115672；python(pid2=122888) ppid=126236（孙进程：是）
杀前：pid1 活 / pid2 活（树完整：是）
dispose() 返回 21ms（taskkill fire-and-forget，不等待）
pid1 在 2946ms 后消失；pid2（孙）在 794ms 后消失
杀后：pid1 死 / pid2 死（树已死：true）
```

- 孙进程比直系父先死（taskkill `/T` 枚举树的终止顺序）；父死后孙未被孤儿化遗留。

### 证据 B：超时路径杀整树 + 会话自愈

```
timeout 结果 +5990ms（2s 预算 + 约 3.5s taskkill）："error: 执行超过 2 秒未完成，已终止终端会话（下次调用自动重建）"
树（从 pidfile 读回）：pid1=118516，pid2=123544；杀后 alive=false/false
pid1 在 868ms 后消失；pid2（孙）在 895ms 后消失
自愈：下次调用 exit: 0
```

- 后台孙树（`Start-Process` 派生）随会话超时一起被清，无残留进程占用管道。

### 证据 C：`killProcessTree()` 直接 API

```
spawned pid=120844；alive=true
killProcessTree 返回 2447ms；alive=false（已死：true）
```

- taskkill `/T /F` 单次调用耗时 2.4–3.0s（与预研的 1.6–3.0s 一致）。

## 关键坑（实测新记录）

1. **`tasklist` 退出码不能判活**：`/FI "PID eq <不存在>"` 也返回 exit 0（打印 GBK
   编码「信息: 没有运行的任务匹配指定标准。」）。必须以**输出行是否含独立 PID token**
   判定，或用 `tasklist /FI ... /FO CSV` 解析。本卡测试/探测均按输出判定。
2. **cmd `start /b python -c "…"` 在本机不执行代码**：python 进程被启动（tasklist
   可见）但脚本不跑、pidfile 不写；`start /b python <脚本.py>` 同样如此。疑似
   Microsoft Store `WindowsApps\python.exe` 占位 stub。`start /b cmd /c echo`（控制组）
   正常；会话内直跑 `python -c` 正常。探测改用 PowerShell `Start-Process` 派生后台
   孙树（返回立即、子进程保留在会话进程树内，`taskkill /T` 可及）。

## 结论

- 已实现的 Windows 整树终止路径（`killProcessTree` → `taskkill /PID <pid> /T /F`，
  process-runner.ts；经 `ShellSession.dispose()` / 超时 / 取消统一复用）在本机
  实测可杀**整棵进程树含孙进程**，杀后无孤儿、管道随树死关闭、会话超时后自愈。
  与预研 [P4-win-process-probe.md](./P4-win-process-probe.md) 结论一致，验收项达成。
