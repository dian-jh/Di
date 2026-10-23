# 事件

`packages/agent/src/types.ts` 定义 agent loop 对外的 `AgentEvent` 联合类型，包括文本和推理增量、
工具调用增量、工具开始/完成、回合完成、运行失败和软停止。事件保留 camelCase 的内部类型。

宿主的 `packages/coding-agent/src/core/events/event-bus.ts` 导出 `EventBus` 与 `EventConsumer`：
发布方同步入队，消费者以异步迭代读取，并可释放订阅。CLI 模式从总线读取事件，渲染或转换成
TUI/RPC wire 形状。`log-events.ts` 定义日志生命周期事件；`model-call-probe.ts` 为模型调用
发布诊断事件。

关键入口：`packages/agent/src/types.ts`（`AgentEvent`）、
`packages/coding-agent/src/core/events/event-bus.ts`（`EventBus`、`EventConsumer`）。RPC 字段见
[`docs/tui-rpc.md`](../tui-rpc.md)。
