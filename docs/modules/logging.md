# 日志

`packages/coding-agent/src/core/logging/di-log.ts` 的 `DiLog` 将运行生命周期写入
`~/.di/logs/di-YYYY-MM-DD.log`，按本地日期每日轮转。日志记录回合、模型调用与工具等摘要，不写
原始流内容；长字段折叠并限制长度。每行会通过 `redactSensitive` 遮蔽 token、API key、
Authorization、Cookie 等敏感值。

日志目录不可写或写入失败时静默丢弃日志，不打断主流程。进程类工具诊断由
`packages/coding-agent/src/core/logging/process-diagnostics.ts` 的 `ProcessDiagnostics` 接入。
会话 checkpoint 写入有独立的失败关闭语义，详见 [`sessions.md`](sessions.md)。
