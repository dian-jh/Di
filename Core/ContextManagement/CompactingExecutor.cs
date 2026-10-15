using Core.AgentLoop;
using Core.Llm;
using Core.Tools;

namespace Core.ContextManagement;

/// <summary>
/// L1 工具结果预算控制：包装 <see cref="IToolExecutor"/>，在"执行后、进轨迹前"拦截
/// （docs/context-compression.md §3.1 / §5.1 的执行缝）。白名单工具（read_file / grep / glob /
/// 平台 shell 工具 / powershell / python，注册名见 <see cref="CoreTools"/>）的结果超过预算阈值
/// （B_predicted ≥ soft 水位线，§6.3）时，完整输出落盘到 artifacts 目录，上下文只留摘要 +
/// artifactRef 引用；edit_file / write_file 永不落盘改写（不在白名单）。
///
/// 工具调用协议（tool_use / tool_result 配对）不受影响：本装饰器只改观察文本的表示，
/// 不增删调用或结果消息。落盘或摘要任一步失败 → fail-safe 回退完整文本进上下文，绝不打断回合。
/// </summary>
public sealed class CompactingExecutor : IToolExecutor
{
    /// <summary>
    /// 可清理工具白名单（§3.1，借鉴 Claude Code TOOLS_CLEARABLE_RESULTS）：纯检索 / 执行产物，
    /// 丢中间不影响工具调用协议。<see cref="CoreTools.PlatformShellName"/> 覆盖 Windows 的 "cmd"
    /// 展示名，内部注册键 "bash" 保留兼容别名（两者路由到同一 shell 工具实例）。
    /// </summary>
    private static readonly IReadOnlySet<string> ClearableTools = new HashSet<string>(
        [CoreTools.ToolNames.ReadFile, CoreTools.ToolNames.Grep, CoreTools.ToolNames.Glob,
         CoreTools.ToolNames.Bash, CoreTools.ToolNames.PowerShell, CoreTools.ToolNames.Python,
         CoreTools.PlatformShellName],
        StringComparer.Ordinal);

    private readonly IToolExecutor _inner;
    private readonly BudgetPolicy _policy;
    private readonly IArtifactStore _artifacts;

    /// <summary>B_current：本回合已累计的输入 token（跨回合累计的接入记下一步，见模块文档）。</summary>
    private readonly Func<int> _currentInputTokens;

    public CompactingExecutor(IToolExecutor inner, BudgetPolicy policy, IArtifactStore artifacts,
        Func<int>? currentInputTokens = null)
    {
        _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        _policy = policy ?? throw new ArgumentNullException(nameof(policy));
        _artifacts = artifacts ?? throw new ArgumentNullException(nameof(artifacts));
        _currentInputTokens = currentInputTokens ?? (() => 0);
    }

    /// <summary>
    /// 执行后按预算策略决定结果进轨迹的表示：完整文本（未越线 / 非白名单 / 失败兜底）
    /// 或 摘要 + 落盘（白名单工具且 B_predicted 越 soft 水位线）。
    /// </summary>
    public async Task<string> ExecuteAsync(ToolCallBlock call, CancellationToken cancellationToken = default)
    {
        var result = await _inner.ExecuteAsync(call, cancellationToken).ConfigureAwait(false);
        if (!ClearableTools.Contains(call.Name))
            return result;

        var resultTokens = TokenEstimator.Estimate(result);
        if (!_policy.PredictsOverSoft(_currentInputTokens(), resultTokens, _policy.NextOutputReserveTokens))
            return result;

        // 摘要上界不变式：输出不超过头+尾预览预算（24000 字符）时，摘要体 = 全文，
        // "摘要 + artifactRef 引用行"必然不小于原文 → 不落盘，完整文本进上下文。
        //（否则"落盘 + 引用行"反而让上下文膨胀，还要白写一个文件。）
        if (result.Length <= OutputBuffer.MaxChars)
            return result;

        // 控制点 = 执行后、进轨迹前：完整输出落盘，上下文只留摘要 + artifactRef。
        try
        {
            var path = _artifacts.Write(call.Name, result);
            var summary = Summarize(result, path);
            if (summary.Length >= result.Length)
            {
                TryReclaim(path);   // 输出恰在预览预算边缘：摘要不严格更小，回收已写文件
                return result;
            }
            return summary;
        }
        catch
        {
            return result;   // fail-safe：落盘/摘要任何一步失败 → 完整文本进上下文，绝不打断回合
        }
    }

    /// <summary>
    /// 确定性摘要（不调 LLM，§3.1）：开头一行 artifactRef 引用（完整输出落盘路径，
    /// 模型可用 read_file 读取）+ 头部 + 省略提示 + 尾部（复用 OutputBuffer 头/尾预算口径）。
    /// 仅当 full &gt; 预览预算（24000 字符）时被调用——此时摘要体必然小于全文。
    /// </summary>
    private static string Summarize(string full, string path)
    {
        var head = full[..OutputBuffer.HeadChars];
        var tail = full[^OutputBuffer.TailChars..];
        var dropped = full.Length - head.Length - tail.Length;
        return RefLine(full, path) + head + $"\n…[省略中间 {dropped} 字符]…\n" + tail;
    }

    /// <summary>artifactRef 引用行：完整输出落盘路径 + 体量说明。</summary>
    private static string RefLine(string full, string path) =>
        $"[工具结果输出过大：完整 {full.Length} 字符（约 {TokenEstimator.Estimate(full)} token）" +
        $"已保存到 {path}，可用 read_file 读取]\n";

    /// <summary>回收因"摘要不严格更小"而不被上下文引用的已写文件；失败不致命（孤儿文件无害）。</summary>
    private static void TryReclaim(string path)
    {
        try { File.Delete(path); }
        catch { /* 回收失败不致命：孤儿文件无害，上下文仍用全文 */ }
    }
}