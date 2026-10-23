# 会话

`packages/coding-agent/src/core/sessions/session-log.ts` 的 `SessionStore` 写入位于
`~/.di/sessions/YYYY/MM/DD/` 的 JSONL。文件包含可供审计的消息/回合记录，也包含恢复所需的
checkpoint 记录；两类用途不能混为一谈。`packages/coding-agent/src/core/sessions/codec.ts` 实现
envelope 与 checkpoint 消息的编码和校验。

每轮 checkpoint 先写 `checkpoint_turn_started`（含历史快照和当前 user），随后写
`trajectory_checkpoint`、`checkpoint_tool_started`、`checkpoint_tool_completed`，最终写
`checkpoint_turn_completed`。工具 intent 必须在执行副作用之前持久化；如果工具已 started 但没有
completed 结果，恢复状态无法判断，必须 fail closed。

`packages/coding-agent/src/core/sessions/session-recovery.ts` 的 `loadRecovery` 校验完整记录：
拒绝未知记录、未知内容块、错序/孤立/重复工具记录和损坏的完整行；只有没有 LF 的末尾撕裂行会
被丢弃。未开始的工具调用可补入明确的“未执行”观察；started 但未完成的调用返回
`unknown-outcome` 错误，禁止自动重放。没有 checkpoint 的旧审计日志不能恢复。

`packages/coding-agent/src/core/sessions/session-stats.ts` 的 `aggregateSessionStats` 离线
聚合回合数、token、缓存命中率和可得成本。
覆盖及固定会话样例位于 `packages/coding-agent/test/session-log.test.ts`、
`packages/coding-agent/test/session-recovery.test.ts`、`packages/coding-agent/test/fixtures/sessions/`。
