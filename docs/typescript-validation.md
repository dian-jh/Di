# TypeScript 验证状态

本页记录当前发布候选的验证事实，不把单元测试或短测等同于长时间验收。验证命令定义在仓库根
`package.json`；跨平台工作流位于 `.github/workflows/typescript-core.yml`。

截至 2026-10-23，提交 `78282657e43185268dff5199454ecf2924151129` 的 Windows Node 24
build、typecheck、unit 与 compat 检查通过；unit 为 1,260 pass / 3 skip，compat 为
17 pass / 1 macOS skip。GitHub Actions run `39926575546` 的 Windows、macOS、Ubuntu ×
Node 22.19/24 六格均成功。详细日志当时保存在 `%TEMP%`，不随仓库分发。

本次清理后的本机 Windows / Node 24 检查中，build、typecheck 均通过；四个 workspace 的
unit 合计 1,257 pass / 3 skip，compat 为 16 pass / 1 macOS skip，CI 测试启动器自身为
3 pass。示例与夹具最后修订后，agent 的 50 项和技能/命令/模式相关的 236 项定向复验均通过。
这些检查使用本地服务与合成凭据，不消耗真实模型 token，也不能代替下列长时间验收。

## 未完成门槛

- 固定候选 `46d58df854b8577f2a7cd239734d525bbe9863b4` 的 10 小时 soak 已完成，但 checker
  因 RSS 最大增量 80,384,000 B、首末两小时 RSS 峰值差 76,251,136 B 超过冻结阈值而失败；
  恢复 p95 为 9,394 ms，低于 60,000 ms。阈值未调整，该失败仍需定位。
- 候选 `0faa697dc7654c4c5eefa9cb463e1170973e8866` 的 10 小时 soak 曾在
  2026-10-23 07:58:08Z 启动。截至最新样本 13:53:09Z，运行约 5 小时 55 分，61,147 轮、
  0 失败、0 子进程残留；RSS 为 171,757,568 B，恢复耗时 9,050 ms，OS 句柄数 211。
  该运行尚未满 10 小时，最终 checker 尚无结果，不能视为通过。原始样本与监督器记录位于
  `%TEMP%/di-migration-final-soak-20261023/run-0faa697-20261023T0725Z/candidate-0faa697-full/`。
- 候选 `78282657e43185268dff5199454ecf2924151129` 的队列曾处于 waiting；不得将排队或预热
  视为 soak 结果。计划中的三平台最终候选 10 小时 soak、macOS CFNetwork 自动代理解析和
  真实 PAC/WPAD 网络验收尚未完成。

冻结阈值及固定候选失败数值保存在 [`docs/soak-thresholds.json`](soak-thresholds.json)。
以上时间点和摘要来自既有运行记录；运行产物位于仓库外的 `%TEMP%`，本页不声称其文件仍可访问。
重新发布前应基于实际候选重新执行对应门槛，并保留原始日志和冻结阈值。
