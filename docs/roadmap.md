# 路线图

当前项目以 TypeScript workspace 作为 CLI 和 agent harness 实现。核心功能入口见
[`docs/modules/README.md`](modules/README.md)，验证事实见
[`docs/typescript-validation.md`](typescript-validation.md)。

## 近期优先顺序

1. **定位长测的 RSS 峰值。** 当前已有候选超过冻结的 RSS 门槛，不能直接判为泄漏或放宽阈值。
   先对齐峰值附近的 heap、外部内存、private bytes、恢复子进程和回合数，再用短时对照实验定位原因。
   入口是 `packages/coding-agent/test/soak/soak-runner.mjs`、
   `packages/coding-agent/test/soak/soak-check.mjs` 和
   `packages/coding-agent/src/core/agent-session.ts`。修复后固定实际 release SHA，在干净工作区
   重新验收；历史候选结果不能替代新提交。原始证据与门槛只在验证状态页维护。
2. **让安装升级支持失败回退。** `install.ps1` 当前先删除已安装的 `ts-cli` 再复制运行时。
   下一步先增加“复制或 smoke 失败后旧命令仍可运行”的测试，再改为暂存新运行时、验证后切换，
   并保留上一个可用版本。现有验证入口为
   `packages/coding-agent/test/cli/install-runtime.test.ts`；验收应从仓库外调用 `di`，且不改用户数据。
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
