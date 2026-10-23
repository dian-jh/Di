# 路线图

当前项目以 TypeScript workspace 作为 CLI 和 agent harness 实现。核心功能入口见
[`docs/modules/README.md`](modules/README.md)，验证事实见
[`docs/typescript-validation.md`](typescript-validation.md)。

## 近期优先顺序

1. **复验 RSS 峰值。** 已增加只读工作集分类工具，并修复长测工具的恢复子进程回收/计数和
   日志统计缓冲。已观察到的 RSS 峰值仍超过冻结门槛；历史峰值缺少页分类快照，不能宣布泄漏已修复。
   下一步固定实际 release SHA，在干净工作区重新验收，并在峰值发生时保存页分类。证据、
   工具入口和未完成门槛统一见 [`docs/typescript-validation.md`](typescript-validation.md)。
2. **安装升级失败回退已实现。** 安装器先暂存、验证再切换，失败保留或恢复旧版本；上一版保留、
   并发锁与用户数据保护行为统一见 [`docs/di-home.md`](di-home.md)，回归测试位于
   `packages/coding-agent/test/cli/install-runtime.test.ts`。
3. **降低恢复会话的使用成本。** 当前 `--resume <file>` 需要用户提供 JSONL 路径。
   可先提供最近会话列表及选择恢复，复用
   `packages/coding-agent/src/core/sessions/session-log.ts` 和
   `packages/coding-agent/src/core/sessions/session-recovery.ts` 的校验，
   不重复实现恢复逻辑。最小验收包含会话排序、选择正确文件、损坏记录提示及恢复前不调用模型。

## 平台能力

Windows 系统代理实现在 `packages/coding-agent/src/cli/windows-system-proxy.ts`；真实 PAC/WPAD
网络验收仍需受控环境。macOS 的 `packages/coding-agent/src/cli/macos-system-proxy.ts` 支持静态
代理，自动 PAC/WPAD 当前明确报错；后续再补 CFNetwork 解析与真实网络验证。应按目标平台给出
发布范围，不能把尚未实现的 macOS 自动代理描述成已支持，也不必让它阻塞 Windows 的独立改进。
