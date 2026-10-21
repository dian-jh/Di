# P9-release-install-rollback-probe：di-ts 安装 / 卸载 / 回退演练证据

> 状态：**演练完成（证据已记录）**。旧（C# di）、新（di-ts）实现使用**不同**的临时 `DI_HOME`；
> 全程未接触、未读取、未改写任何真实用户数据（受保护路径下只有合成 config.json + 一条假 session）。
> 契约权威：[`validation-and-release.md`](../validation-and-release.md)「安装、切换、用户数据与回退」（§120-128）。
> 平台：Windows 11 Enterprise（build 26100），PowerShell 5.1，Node `v24.16.0`，Git Bash（msys）宿主。
> 安装脚本：`install.ps1`（仓库根，P9 提交 `0c3ab6d`）；生产入口 `di-ts` → `packages/coding-agent/dist/cli/main.js`（`cb15387`）。
> 演练目录（合成数据）：`%TEMP%\p9-drill2\`（脚本 `drill.ps1`、证据 `evidence.txt`、受保护 home `home\`、
> 安装目标 `install\`、TS 运行时 home `runhome\`）；早期一轮在同名 `%TEMP%\p9-drill\`（含对真实 `~/.di` 的 216 条
> SHA-256 快照，同样四阶段逐字节一致）。

## 结论摘要

1. **安装只写两个自有目录**：`install.ps1` 把 TS 运行时放到 `<diHome>/ts-cli/`、把 `di-ts` 启动器放到
   `<diHome>/bin/`，二者都在重装时整目录重建；**绝不移动/删除/改写** `<diHome>/config.json`、
   sessions、skills、commands、auth/credentials（脚本头部明示该数据安全保证）。
2. **C# di 保持默认且逐字节不变**：`bin/di.exe` 从不在安装/卸载中被触碰；安装后 `di.exe --version` 仍
   `exit 0`。默认命令仍是 C# `di`，`di-ts` 是并行新命令 —— 与 §128「先并行试用、再切默认入口」一致，
   默认入口切换保持 PENDING（见 10h soak + 跨平台 gate）。
3. **用户数据在 install → uninstall → reinstall 全程逐字节一致**：对受保护 home 的 config.json + sessions
   做 SHA-256 快照，四个时点（before / after-install / after-uninstall / after-reinstall）全量一致
   （`snapshot-diff: IDENTICAL`）。早期一轮对真实 `~/.di` 的 216 条快照同样四阶段一致。
4. **卸载干净**：移除 `bin/di-ts.cmd`、`bin/di-ts` 与 `ts-cli/` 后 `leftover-files` 为空；C# 仍可运行。
5. **di-ts 从隔离安装目录可用**：`--info`、`--help`、`--version` 均 `exit 0`；`--mode json "hi"`
   （无 API Key，隔离 DI_HOME）返回 `{"error":{"code":"model_error",...}}` 信封且 `exit 1` —— 证明
   宿主组合、session 存储、错误路径在无真实 provider 下完整可用。
6. **卸载 = 手工两步**（删 2 个启动器 + `ts-cli/`），无独立 uninstall 脚本 —— 记录为有意简化，
   重装（再次跑 install.ps1）与卸载互为逆操作，已在演练中互证。

---

## 1. 演练脚本与命令

`drill.ps1` 按阶段执行并用 `evidence.txt` 记录每条命令输出与 `LASTEXITCODE`。路径与角色：

| 路径（均在 `%TEMP%\p9-drill2\`） | 角色 |
|---|---|
| `home\` | 受保护用户数据（合成）：`config.json` + `sessions/2026/10/21/old-session.jsonl` |
| `runhome\` | 新（TS）运行时 DI_HOME（演练中注入 `$env:DI_HOME`） |
| `install\` | 安装目标 DI_HOME（临时）：`bin\`（启动器）+ `ts-cli\`（运行时） |

关键命令与退出码（直接复核值）：

```text
# 1) 安装（隔离目标，跳过 PATH 写入）
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -DiHome <install> -SkipPathUpdate
    -> exit 0  （[1/6] build、[2/6] ts-cli 拷贝、[3/6] 启动器、[6/6] 隔离 smoke di-ts --info 全过）

# 2) 验证 TS CLI（隔离 DI_HOME + 空 API Key）
di-ts --info                                     -> exit 0
di-ts --help                                     -> exit 0
di-ts --version                                  -> exit 0
di-ts --mode json "hi"                           -> exit 1
    {"error":{"code":"model_error","message":"DeepSeek 未配置 API Key。"}}

# 3) 验证 C# 仍默认可运行 + 数据逐字节一致
di.exe --version                                 -> exit 0（输出 0.1.0）
snapshot before vs after-install                 -> IDENTICAL

# 4) 卸载（手工：删启动器 + ts-cli）
Remove-Item -Recurse -Force <install>\ts-cli
Remove-Item -Force <install>\bin\di-ts.cmd, <install>\bin\di-ts
leftover-files:  （空 —— 目录中无残留文件）

# 5) 卸载后验证
snapshot before vs after-uninstall               -> IDENTICAL
di.exe --version                                 -> exit 0

# 6) 重装 = 再跑一次 install.ps1                   -> exit 0
# 7) 重装后验证
di-ts --info (after reinstall)                   -> exit 0
di.exe --version (after reinstall)               -> exit 0
snapshot before vs after-reinstall               -> IDENTICAL
```

注：`drill.ps1` 里 `--help | Select-Object -First 3` 记录到的 `exit -1` 是捕获脚本用 `Select-Object -First`
提前关闭管道导致的 EPIPE，非产品缺陷；直接运行 `di-ts --help` 复核 `exit 0`（见上表）。

## 2. 早期一轮：真实 `~/.di` 四阶段快照一致

`snapshot.ps1` 对 `~/.di` 的 `config.json + sessions + auth + skills + commands + decompiled` 递归做
SHA-256 快照（共 **216 条**：config.json 1 + sessions 212 + auth 2 + decompiled 1），排序后写清单。
`before.txt` / `after-install.txt` / `after-uninstall.txt` / `after-reinstall.txt` 四份
**逐字节相同**（同一 MD5：`c094d241485634607ebee087fb12e09b`）—— 真实用户数据在整轮安装/卸载/重装
过程中未被任何一步触碰。

## 3. C# di 保持可运行（证据）

`~/.di/bin/di.exe`（约 74MB，C# 基线二进制）在整个演练前后 `--version` 恒 `exit 0`，且从未出现在
`install.ps1` 的写路径中（脚本第 [4/6] 步只**探测并列出**既存 `di.exe`/`di`，明确「绝不覆盖」）。
合成保留测试（`%TEMP%\p9-drill\preserve-test\`）：预置 35 字节假 `di.exe` 后再安装，该文件
**逐字节保留**（内容 `synthetic-di-exe-content-0123456789` 未变）。

## 4. 安装布局（重装后）

```text
<install>/
  bin/
    di-ts         POSIX shim（本轮同时写入，供后续 POSIX gate 复用）
    di-ts.cmd     Windows 启动器：node "<bin 同层>..\ts-cli\node_modules\@di\coding-agent\dist\cli\main.js" %*
  ts-cli/
    node_modules/@di/{coding-agent,ai,agent}/   （workspace 包）
    node_modules/di-tui/                        （tui → di-tui）
    node_modules/{jsonc-parser,@earendil-works/pi-tui,marked,get-east-asian-width}/  （第三方闭包叶包）
```

## 5. 记录的有意简化 / 边界

- **卸载脚本未单独提供**：卸载 = 删 `bin/di-ts.cmd` + `bin/di-ts` + `ts-cli/`（2+1 项），已在演练中
  验证可逆、干净；重装 = 再跑 install.ps1。若后续发布流程需要，可补一个对称的 `uninstall.ps1`。
- **PATH 写入**：演练用 `-SkipPathUpdate` 跳过；默认安装幂等追加 `<diHome>/bin` 到 User PATH。
- **默认入口切换（§128 最后一步）保持 PENDING**：本次只并行试用 `di-ts`，不把 `di` 指向 TS；
  切换待 10h soak + session/配置兼容 + 回退证据与跨平台（POSIX 未运行）gate 通过后进行。

## 附：证据文件位置（合成数据，均已退出/清理）

- `%TEMP%\p9-drill2\drill.ps1`、`evidence.txt`、`home\`、`runhome\`、`install\`
- `%TEMP%\p9-drill\snapshot.ps1`、`before.txt`、`after-install.txt`、`after-uninstall.txt`、
  `after-reinstall.txt`、`preserve-test\`、`ts-install\`
