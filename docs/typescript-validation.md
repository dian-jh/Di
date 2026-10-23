# TypeScript 验证状态

本页区分当前分支验证与历史固定候选的长测，不把单元测试或短测等同于长时间验收。验证命令定义在仓库根
`package.json`；跨平台工作流位于 `.github/workflows/typescript-core.yml`。

提交 `94425883dce18f992fb7f372136fdf9cef5b28ed` 已移除历史实现。其
[GitHub Actions](https://github.com/dian-jh/Di/actions/runs/39967453843) 在 Windows、macOS、Ubuntu ×
Node 22.19/24 六个组合中，build、typecheck、unit、compat 均通过。

该提交的本机 Windows / Node 24 检查中，build、typecheck 均通过；四个 workspace 的
unit 合计 1,257 pass / 3 skip，compat 为 16 pass / 1 macOS skip，CI 测试启动器自身为
3 pass。示例与夹具最后修订后，agent 的 50 项和技能/命令/模式相关的 236 项定向复验均通过。
这些检查使用本地服务与合成凭据，不消耗真实模型 token，也不能代替下列长时间验收。

## 未完成门槛

- 固定候选 `46d58df854b8577f2a7cd239734d525bbe9863b4` 的 10 小时 soak 已完成，但 checker
  因 RSS 最大增量 80,384,000 B、首末两小时 RSS 峰值差 76,251,136 B 超过冻结阈值而失败；
  恢复 p95 为 9,394 ms，低于 60,000 ms。阈值未调整，该失败仍需定位。
- 候选 `0faa697dc7654c4c5eefa9cb463e1170973e8866` 的 10 小时 soak 曾在
  2026-10-23 07:58:08Z 启动。截至 14:22:39Z 的样本，运行约 6.4 小时，65,964 轮、
  0 失败、0 子进程残留。首样本 RSS 为 93,069,312 B，全程峰值 223,838,208 B，增量
  130,768,896 B 已超过冻结的 20,971,520 B 门槛；这不能单独证明内存泄漏，仍需分析峰值时的
  heap、外部内存和进程 private bytes。该运行尚未满 10 小时，最终 checker 尚无结果，不能视为通过。
  原始样本与监督器记录位于
  `%TEMP%/di-migration-final-soak-20261023/run-0faa697-20261023T0725Z/candidate-0faa697-full/`。
- 候选 `78282657e43185268dff5199454ecf2924151129` 的队列曾处于 waiting；不得将排队或预热
  视为 soak 结果。这两个候选均早于 `9442588`，不能替代当前分支的验收。最终发布仍需固定实际
  release SHA 并从干净工作区运行。三平台最终候选 10 小时 soak、macOS CFNetwork 自动代理解析和
  真实 PAC/WPAD 网络验收尚未完成；Windows 发布与 macOS 自动代理能力应分别说明支持边界。

冻结阈值及固定候选失败数值保存在 [`docs/soak-thresholds.json`](soak-thresholds.json)。
以上时间点和摘要来自既有运行记录；运行产物位于仓库外的 `%TEMP%`，本页不声称其文件仍可访问。
重新发布前应基于实际候选重新执行对应门槛，并保留原始日志和冻结阈值。
