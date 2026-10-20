# P8-auth-storage-probe：凭据存储事务语义探针

> 状态：**预研完成（证据已记录）**，未接入主流程、未提交。合成凭据只存在于临时目录，未读取任何真实凭据。
> 契约权威：[`models-and-auth.md`](../models-and-auth.md)「OAuth PKCE、轮换与原子凭据写入」一节；
> 固定基线 `09f4e08` 的 [`Core/Providers/ChatGpt/ChatGptCredentialStore.cs`](../../../modules/chatgpt.md) 相关实现。
> 平台：Windows 11 Enterprise（build 26100），Node `v24.16.0`，Git Bash（msys）宿主。
> 探针目录（全部合成）：`%TEMP%\p8-auth-storage-probe\`（脚本 `scripts/`、场景数据 `work/`）。

## 结论摘要（TS 实现必须照此做）

1. **Node 普通 `fs.open` 无法复刻 C# `FileShare.None`**：同一 `session.lock` 用 `a+`（OpenOrCreate 模拟）
   开两个进程可**同时**持有并写入，零互斥。`fs.open(path,'wx')` 的互斥来自「文件存在性」，
   进程崩溃后文件残留 = **永久死锁**（`wx` 后续永远 EEXIST）。这与契约断言一致：
   **不能把 `open('wx')` 文件存在性误说成等价于 `FileShare.None`**。
2. **C# 锁语义没有陈旧锁问题**：`FileMode.OpenOrCreate + FileShare.None` 的排他性在**打开句柄**上，
   不在文件存在性上。持锁进程退出（含被强杀）后 OS 关闭句柄，下一个进程对同一持久文件
   `OpenOrCreate` 立即成功。C# 从不删除 `session.lock`，也因此从不被它阻塞。TS 必须用
   **真实 OS advisory lock**（Windows `LockFileEx`，POSIX `flock`），锁覆盖读、网络 refresh、提交。
3. **Windows ACL 与 Node `stat.mode` 互相脱钩**：`fs.chmod(0o600)` 在 NTFS 上是**无操作**（stat 恒为
   `0o100666`）；只有 `chmod 0` 会翻转只读属性（stat → `0o100444`）。用 .NET/icacls 收紧 DACL 后
   Node `stat.mode` **仍读 `0o100666`**。因此「读回 stat.mode 区分受限/开放」在 NTFS 上**不可行**；
   校验 ACL 必须经原生 API/`icacls` 回读，失败即 fail closed（符合契约）。
4. **原子写模式可用且已实证**：同目录随机临时文件 → 写入 → `fh.sync()` → close → `rename` 覆盖。
   rename 前崩溃（含强杀）：**旧凭据文件原样保留**，只留下孤儿临时文件（需清理）。
   Windows `renameSync` 覆盖既有目标（等价 `File.Move(temp, credentials.json, true)`）。
5. **依赖决策**：无纯 JS 的跨平台 OS advisory lock 依赖可用。`proper-lockfile@4.1.2`（mkdir+mtime
   staleness）与 `lockfile@1.0.4`（mkdir）都被契约明确禁止（不得用 mkdir/TTL 替代）。
   `fs-ext@2.1.1`（MIT）是唯一提供 Windows `LockFileEx` + POSIX `flock` 的候选，但**原生 node-gyp
   构建在本机失败**（无 Visual Studio Build Tools，且未发布预编译二进制）。结论：
   lock 采用「经审查原生适配器 + 无法加载/获取锁时 **fail closed**」；陈旧锁仅经明确离线人工恢复，
   **禁止自动按年龄/PID 删除**。

---

## 1. 跨进程锁竞争（`fs.open 'wx'`）

脚本：`lock.js <mode> <lockfile> <holdMs> [retryMs] [maxRetryMs]`。两个独立 Node 进程同时抢同一锁文件。

```bash
node lock.js wx .../session.lock 2000 50 5000   # 进程 A
node lock.js wx .../session.lock 2000 50 5000   # 进程 B（同时启动）
```

实测输出（bash 后台同时启动，`wait` 收集退出码）：

```text
A: ACQUIRED pid=94636 mode=wx ... at +1747ms   (A exit=0)
B: ACQUIRED pid=86940 mode=wx ... at +1ms      (B exit=0)
# 另一轮：A +1ms 先拿，B EEXIST 重试，A 2000ms 后 unlink 释放，B +2051ms 拿到。均 exit=0。
```

- **确定性地恰好一个赢**：赢家在 +1ms 级创建文件，输家每次 `open('wx')` 得 `EEXIST`，按 `retryMs`
  轮询等待，赢家 `unlink` 后输家即可获得。全程 exit 0。
- **无等待模式**（`wx-noretry`，A 持锁 1500ms）：B 立即 `EEXIST`，exit **3**。竞争失败路径可确定复现。
- **语义本质**：`wx` = `O_CREAT|O_EXCL`，把「文件存在」当作锁。只要没人 unlink，文件一旦存在就永远是锁。

## 2. 持锁进程退出 / 崩溃行为

### 2a. 正常 `process.exit()` 不 unlink（模拟崩溃）

```text
A exit=0   ACQUIRED ... CRASH-SIM ... exiting WITHOUT unlink -> exit 0
锁文件仍在，内容=[105156]（PID）
B（wx，重试 3s）: TIMEOUT ... after 3058ms -> exit 2   # 永久拿不到
```

### 2b. 强杀 `taskkill /F`（更硬的崩溃）

```text
A 持锁 60s，锁文件内容=[105604]；taskkill /F 成功
锁文件仍在，内容=[105604]
B（wx-noretry）: EEXIST -> exit 3
```

**结论**：进程死亡时 OS 只关闭文件句柄，**不删除文件**。`wx` 把文件存在性当锁，所以崩溃后
陈旧文件永远阻塞后续获取，除非人工删除。PID/mtime 陈旧恢复不可靠（PID 复用、进程暂停、竞态
unlink 均会误删活锁），契约因此禁止自动回收 —— 探针证实了这一禁令的必要性。

### 2c. C# 对照：`FileShare.None` 在句柄上，不在文件存在性上（决定性）

用 .NET（PowerShell 进程）按 `LockAsync` 语义做三段演示，`session.lock` 全程不删除：

```text
A（.NET）: 以 OpenOrCreate/ReadWrite/FileShare.None 持有，写 ready.flag，Hold 6s
B（.NET，A 持锁期间）: attempt 0-3 全 IOException -> B blocked 4x while A holds -> CORRECT exclusion
C（.NET，A 退出后）: C acquired on persistent file -> no stale-lock problem
session.lock 仍在磁盘
```

- 持锁期间另一进程 `IOException`（=C# `LockAsync` 的 catch IOException 重试路径）。
- **A 退出后**，同一持久文件立即被 C 获得 —— 无陈旧锁问题，因为排他性随句柄释放而消失。
- C# 从不删除 `session.lock`，也从不被残留文件阻塞。这正是 TS 需要保留的保证。

### 2d. 反证：Node 普通 `a+` 打开无互斥

```text
A: ACQUIRED(a+) pid=46248（a+ 打开 session.lock）
B: ACQUIRED(a+) pid=47008（同一文件，同时打开成功）
锁文件内容=[4624847008]   # 两个 PID 都被追加写入 = 同时持有
```

**Node 默认 `fs.open` 在 Windows 上不设排他 share-mode**，两个进程可同时读写同一文件。所以
`FileShare.None` 语义必须经原生 OS 锁（`LockFileEx`/`flock`）获得，普通 `fs.open('a+')` 不行。

## 3. Unix mode / Windows ACL 回读现实

### 3a. `fs.chmod` 在 NTFS 上几乎无操作

```text
创建文件 stat.mode = 0o100666
chmod 0o600/700/644/755/777 -> 全部 OK，但 stat.mode 恒为 0o100666（掩码 0o666）
chmod 0o0 -> stat.mode = 0o100444，且 access(R|W) 报 EPERM
```

只有 `0o000` 会把只读属性（FILE_ATTRIBUTE_READONLY）置位；owner/group/other 位一律不生效。
**Node `stat.mode` 无法区分 0600 与 0666**。

### 3b. DACL 收紧后 Node 依然看不见

用 `SetAccessRuleProtection(true, false)` + 仅当前用户 FullControl 收紧 DACL：

```text
收紧前（继承）：5 条 ACE（SYSTEM、BUILTIN\Administrators、EHI\52143 FullControl 等，全部 IsInherited=True）
收紧后：      1 条 ACE —— EHI\52143:(F)，IsInherited=False
icacls 回读：  C:\...\creds.json EHI\52143:(F)
Node stat.mode：0o100666   # 收紧前后完全不变
```

**现实**：ACL 生效（其他主体被拒），但 Node `fs.stat()` 的 mode 字段**完全不反映 DACL**。
「回读 stat 验证权限」在 NTFS 上不可行。验证/设置 ACL 必须走原生路径（如
`SetNamedSecurityInfoW`/`GetNamedSecurityInfoW`，或子进程 `icacls`），失败即 fail closed 拒写 token
（符合契约「不能只记 warning 后继续声称安全等价」）。

## 4. 原子写 / 失败不覆盖旧凭据

脚本 `atomic-write.js`：同目录随机 `tmp-<pid>-<ts>.tmp` → `fh.writeFile` → `fh.sync()` → close →
`fs.promises.rename` 覆盖 `credentials.json`。

### 4a. rename 前崩溃（写完后 `process.exit(0)`）

```text
temp 已写且 flush+close（"NEW-CREDENTIALS-V2"）
CRASH-SIM: exiting before rename
旧文件= [OLD-CREDENTIALS-V1]   # 原样保留 ✓
残留孤儿 temp 文件 1 个
```

**断言成立：rename 从未发生，旧凭据不被覆盖。** 崩溃留下孤儿 `.tmp`，C# `finally` 清理在正常路径
生效、崩溃路径靠下次运行清理（TS 可对 `*.tmp` 做启动清理，但不该依赖它作安全保证）。

### 4b. 正常 rename

```text
rename 后 credentials.json = "NEW-CREDENTIALS-V2"，temp 不存在
```

### 4c. Windows rename 覆盖既有目标 + 跨卷

```text
renameSync 覆盖既有 target：OK，target=[SRC-NEW]（等价 File.Move(..., true)）
跨卷 rename 到 OS temp：OK
同卷 rename 延迟：100 次共 184.9ms，平均 ~1.85ms/op
fsync + fdatasync 在 win32 均可用
```

## 5. 依赖决策记录

| 候选 | 版本 | 许可 | 机制 | 结论 |
|---|---|---|---|---|
| `proper-lockfile` | 4.1.2 | MIT | `mkdir` 策略 + 周期更新 mtime 判陈旧 | **拒绝**：契约明确禁止 mkdir/TTL 替代 OS 锁 |
| `lockfile` | 1.0.4 | ISC | `mkdir` 锁文件 | **拒绝**：同上 |
| `fs-ext` | 2.1.1 | MIT（npm 元数据缺 license 字段；GitHub API 返回 MIT，仓库含 LICENSE.txt） | 真实 `flock`（POSIX）+ `_win32_flock`（Windows `LockFileEx`，见 `fs-ext.cc` `#ifdef _WIN32` 分支） | **唯一形状匹配的候选，但安装是本机阻塞**：node-gyp 原生构建失败（`find VS` 找不到 Visual Studio Build Tools；未发布预编译二进制）。依赖 `nan ^2.21.0` |

`fs-ext@2.1.1` 探针结论：API 与契约首选完全一致（Windows `LockFileEx` / POSIX `flock`），
但**原生构建/分发**是硬门槛 —— 需要 CI 预编译 win32-x64 binary 或要求目标机有 VS Build Tools。
按契约「原生 helper 必须一并有构建、分发、失败路径」，在未解决构建分发前不得纳入主链路。

## 6. 推荐的 TS 方案

1. **锁**：优先经审查原生适配器提供 `LockFileEx`（Windows）/ `flock`（POSIX），锁覆盖
   读 → 锁内重读 → refresh 网络调用 → 原子提交；等待支持 AbortSignal、退避、上限。
   **若原生模块无法加载或锁获取失败 → fail closed**：保留旧凭据、返回可恢复错误，绝不自动
   按 PID/年龄回收陈旧锁（陈旧锁仅人工离线恢复）。绝不使用 `wx` 存在性锁 + 自动 TTL 回收。
2. **原子写**：同目录唯一临时文件 → 写 → `fh.sync()` → close → `rename` 覆盖；异常清理临时文件，
   旧文件保持完整（4a 已实证）。Windows ACL 经原生 API 设置并回读确认，失败拒写。
3. **ACL 回读**：不依赖 `stat.mode`（NTFS 下无效，3b 已实证）；用原生 ACL API 回读 DACL 验证。
4. **验收门**：多进程竞争测试（1 个赢、其余等待/失败确定性）、崩溃后旧凭据不覆盖、ACL 收紧后
   stat 不可见但原生回读可见。

## 附：探针脚本与真实命令（供复核）

探针目录 `%TEMP%\p8-auth-storage-probe\`（合成数据，已清理的进程均已退出）：

| 脚本 | 用途 | 关键命令 / 退出码 |
|---|---|---|
| `scripts/lock.js` | 锁语义 | `wx`（赢=0/输重试后=0）、`wx-crash`（=0）、`wx-noretry`（EEXIST=3）、`aplus`（无互斥=0） |
| `scripts/acl-probe.js` | chmod 回读 | 全部 chmod 后 stat.mode 恒 `0o100666`；`chmod 0` → `0o100444` + EPERM |
| `scripts/atomic-write.js` | 原子写 | `crash-before-rename`（旧文件保留、孤儿 tmp 1 个）、`normal`（替换成功）、`cross-volume`（OK） |
| PowerShell 三段 | C# `FileShare.None` 对照 | A 持锁时 B 4×IOException；A 退出后 C 立即获得；文件不删除 |
| PowerShell `Get-Acl`/`Set-Acl` | DACL 收紧 | 收紧后 1 ACE（`EHI\52143:(F)`）；Node stat.mode 仍 `0o100666` |
| `icacls` | ACL 回读 | 收紧后 `EHI\52143:(F)` |

未执行：真实凭据读写、真实账号登录、跨平台（POSIX）探针 —— 均留待后续平台 gate。
