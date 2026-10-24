# TypeScript 验证状态

本页区分当前分支验证与历史固定候选的长测，不把单元测试或短测等同于长时间验收。验证命令定义在仓库根
`package.json`；跨平台工作流位于 `.github/workflows/typescript-core.yml`。

截至 2026-10-24，产品代码、默认 CLI、安装器及 CI 已切换到 TypeScript；受 Git 跟踪的文件中
没有 C# 源码、项目文件或 .NET 构建链路。原 `docs/migration/typescript-core/` 迁移计划与台账
已在 `9442588` 删除。本页仍保留，因为发布验收尚未全部完成，不代表运行时仍依赖旧实现。

当前候选 `3acfe4faef286e187fc5cd156024beeba6d2d603` 的
[GitHub Actions](https://github.com/dian-jh/Di/actions/runs/39978630488) 六个组合全部通过，
涵盖 build、typecheck、unit 和 compat；该 CI 不包含真实模型 smoke 或 10 小时 soak。

提交 `94425883dce18f992fb7f372136fdf9cef5b28ed` 已移除历史实现。其
[GitHub Actions](https://github.com/dian-jh/Di/actions/runs/39967453843) 在 Windows、macOS、Ubuntu ×
Node 22.19/24 六个组合中，build、typecheck、unit、compat 均通过。

该提交的本机 Windows / Node 24 检查中，build、typecheck 均通过；四个 workspace 的
unit 合计 1,257 pass / 3 skip，compat 为 16 pass / 1 macOS skip，CI 测试启动器自身为
3 pass。示例与夹具最后修订后，agent 的 50 项和技能/命令/模式相关的 236 项定向复验均通过。
这些检查使用本地服务与合成凭据，不消耗真实模型 token，也不能代替下列长时间验收。

## RSS 排查与长测工具修正

候选 `0faa697` 的既有样本中，Node RSS 与 Windows PSAPI working set 基本一致，未发现显著的
读数接口偏差。2026-10-23 14:55:13Z 的只读页分类中，工作集为 171,921,408 B，其中
142,807,040 B 的页带 shareable 标志，主要属于 `MEM_IMAGE` 与 `MEM_MAPPED`。
同次 `PrivateUsage` 为 83,587,072 B：它是私有提交内存，不能当作私有工作集与 RSS 直接相减。
API 语义见微软的 [Shared 位定义](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-psapi_working_set_block)
与 [PrivateUsage 定义](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex)。

上述分类只能解释该采样时刻，不能倒推旧峰值的页组成。旧峰值期间 heap 与私有提交内存未同步增长，
之后 RSS 回落；基础短对照中原生采样/DLL 加载只增加数 MB。现有证据不足以认定业务层泄漏，
也不足以宣布资源验收通过；冻结 RSS 门槛保持不变。

`packages/coding-agent/test/soak/inspect-working-set.mjs` 导出 `inspectWorkingSet`，可在 Windows x64
用 `--pid` 指定长测进程；不传则检查自身。仅查询工作集及虚拟页元数据，不读取目标页内容或 CLI 配置。
结果区分 shareable/notShareable 与内存区域类型，未知类型明确保留。Shared 表示页可共享，
ShareCount 分布单独记录；页分类与 RSS 取样时间略有差异，不应要求字节数完全相同。

已修正的长测工具问题：

- `packages/coding-agent/test/soak/resume-child.mjs` 的 `runResumeChild` 将握手与退出分开，成功必须
  收到 `RESUMED` 且子进程 `close` 返回 0。恢复子进程也计入创建/回收数；超时分级终止，最终仍无法
  回收则记录 PID、停止产生新回合并写失败状态，不把它算作成功。
- `packages/coding-agent/test/soak/checkpoint-tracker.mjs` 的 `makeCheckpointTracker` 复用固定
  64 KiB 缓冲扫描新增日志，避免按增长字节数反复分配临时 Buffer。
- `packages/coding-agent/test/soak/soak-runner.mjs` 分别记录恢复握手、等待退出的总耗时，以及恢复
  子进程数。旧版本的 `active_children=0` 不能证明恢复子进程已回收；旧结果不重写为新工具的证据。
- `packages/coding-agent/test/soak/soak-path-validation.mjs` 在创建 host 或写文件前验证必填路径。
  `DI_HOME` 必须位于 `out` 的父目录之内，且不得覆盖用户家目录、默认数据根或仓库/workspace；
  推荐使用 supervisor 自动生成的 `runRoot/di-home`、`runRoot/artifacts` 布局。缺值及被后续选项
  吞掉的路径直接拒绝，防止诊断误写正常用户目录。

对应回归测试位于 `packages/coding-agent/test/compat/soak-helpers.test.mjs` 与
`packages/coding-agent/test/compat/soak-working-set.test.mjs`，路径入口回归位于
`packages/coding-agent/test/compat/soak-path-validation.test.mjs`，均纳入 `npm run test:compat`。

本轮本机 Windows / Node 24 开发回归中，build、typecheck 通过，unit 为 1,267 pass / 3 skip，
compat 为 32 pass / 1 macOS skip。真实一分钟回归完成 153 轮、51 次清理、51 次恢复，恢复子进程
创建/回收均为 51，最终工具及恢复子进程存活数均为 0。32 个采样的 RSS 最大增量为 888,832 B。
这次高频恢复回归使用开发工作区和合成模型，只验证功能及回收，不是干净固定候选的 10 小时资源验收。

## 未完成门槛

- 固定候选 `46d58df854b8577f2a7cd239734d525bbe9863b4` 的 10 小时 soak 已完成，但 checker
  因 RSS 最大增量 80,384,000 B、首末两小时 RSS 峰值差 76,251,136 B 超过冻结阈值而失败；
  恢复 p95 为 9,394 ms，低于 60,000 ms。阈值未调整，该失败仍需定位。
- 候选 `0faa697dc7654c4c5eefa9cb463e1170973e8866` 的 10 小时 soak 曾在
  2026-10-23 07:58:08Z 启动，现已完整结束：36,000,264 ms、102,936 轮、343 次恢复，
  回合及恢复均无失败。最终 checker 失败，唯一失败项为 RSS 最大增量：首样本 93,069,312 B，
  全程峰值 223,838,208 B，增量 130,768,896 B 超过冻结的 20,971,520 B 门槛。
  最终 RSS 回落至 107,982,848 B，首末两小时 RSS 峰值趋势门通过；恢复 p95 为 8,105 ms，
  handles、子进程及其他门槛通过。这些结果不能单独证明泄漏，也不能将本次验收记为通过；
  恢复子进程计数仍受前述旧工具缺陷限制。
  原始样本与监督器记录位于
  `%TEMP%/di-migration-final-soak-20261023/run-0faa697-20261023T0725Z/candidate-0faa697-full/`。
- 当前候选 `3acfe4f` 在干净工作区完成 35 分钟预热：6,427 轮、21 次恢复全部成功，
  supervisor 退出码 0、runner `completed=true`，结束时工具及恢复子进程存活数均为 0。
  72 个样本的 RSS 最大增量为 1,523,712 B；预热不能代替 10 小时验收。
  仓库外的 `%TEMP%/di-stability-install-20261023/queued-validation.mjs` 在预热输出流已结束后
  再次结束该流，报 `Cannot call end after a stream was finished`，队列因此退出，未启动 full 阶段。
  这是调度脚本失败；不能把空的 `phases` 记录当作产品预热失败，也不能声称长测仍在排队运行。
  原始产物位于 `%TEMP%/di-stability-install-20261023/candidate-3acfe4f-serial/`；
  需修正编排后重新执行完整长测，冻结阈值不变。
- 候选 `78282657e43185268dff5199454ecf2924151129` 的队列曾处于 waiting；不得将排队或预热
  视为 soak 结果。`0faa697` 与 `78282657` 均早于 `9442588`，不能替代当前分支的验收。最终发布仍需固定实际
  release SHA 并从干净工作区运行。三平台最终候选 10 小时 soak、macOS CFNetwork 自动代理解析和
  真实 PAC/WPAD 网络验收尚未完成；Windows 发布与 macOS 自动代理能力应分别说明支持边界。

冻结阈值及固定候选失败数值保存在 [`docs/soak-thresholds.json`](soak-thresholds.json)。
以上时间点和摘要来自既有运行记录；运行产物位于仓库外的 `%TEMP%`，本页不声称其文件仍可访问。
重新发布前应基于实际候选重新执行对应门槛，并保留原始日志和冻结阈值。
