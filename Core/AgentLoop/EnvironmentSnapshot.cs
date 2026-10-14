using System.Text;

namespace Core.AgentLoop;

/// <summary>
/// 环境感知快照——「最小化注入 + 工具自取」策略（参考 pi：system-prompt.ts 只注入 cwd，
/// git 分支归 UI 层 footer-data-provider，仓库详情由模型用 bash 自取）：
/// 提示词里只注入<b>工作目录 + 一行自取提示</b>，不注入 git 分支 / 改动 / 提交。
/// 理由：仓库详情是低频、易变信息——每个回合都支付它的 token 与 git 进程
/// （Windows 上每次 git spawn ≈100ms+，且注入内容拉高 TTFT）只为少数真正需要的回合；
/// 模型需要时可自行用 bash 运行 <c>git status --short -b</c> / <c>git log --oneline -5</c> 获取。
/// git 分支的用户可见展示（如有）属 UI 层职责，不进 LLM 上下文。
///
/// 由 <see cref="AgentRunner"/> 在每个回合开始时捕获：文本恒定 → 首次进入历史后
/// 留在字节稳定前缀里，跨回合持续命中缓存（AgentRunner 按内容去重，见 <c>_lastSnapshotText</c>）。
/// </summary>
public static class EnvironmentSnapshot
{
    /// <summary>
    /// 生成最小化环境快照：工作目录 + 自取提示。<b>不执行任何 git 进程、不注入仓库状态</b>。
    /// 仓库详情（分支 / 改动 / 提交）改为模型需要时用 bash 自助查询（工具自取）。
    /// </summary>
    /// <remarks>保留 CancellationToken 参数以维持调用契约（未来如重新引入惰性 git 探测仍需要）。</remarks>
    public static Task<string> CaptureAsync(string workingDirectory, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(workingDirectory);

        var sb = new StringBuilder();
        sb.AppendLine("## 环境");
        sb.AppendLine($"- 工作目录: {workingDirectory}");
        sb.AppendLine("- 分支 / 未提交改动 / 最近提交需要时用 bash 自助查询：git status --short -b、git log --oneline -5");
        return Task.FromResult(sb.ToString().TrimEnd());
    }
}