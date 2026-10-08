using System.Text;
using Core.Tools;

namespace Core.AgentLoop;

/// <summary>
/// 环境感知快照（第五章「状态栏技术」）：把工作区状态渲染成注入给模型的简短文本，
/// 让模型不用靠 bash 探测就知道自己在哪个目录、什么 git 分支、最近的提交、有哪些未提交变更。
/// 由 <see cref="AgentRunner"/> 在每个回合开始时刷新，经 <see cref="AgentRequest.SystemContext"/>
/// 注入到 stable_prefix 之后。
///
/// 原则：
/// <list type="bullet">
/// <item>尽力而为：git 缺失 / 非 git 目录 / git 出错 / git 超时都静默省略 git 部分，绝不抛异常、绝不让回合失败。</item>
/// <item>紧凑：变更概览截断到 <see cref="MaxStatusLines"/> 行，避免大仓库撑爆上下文。</item>
/// <item>git 往管道写 UTF-8 字节（与 cmd/python 的 OEM 字节不同），必须显式按 UTF-8 解码，否则中文提交信息乱码。</item>
/// </list>
/// </summary>
public static class EnvironmentSnapshot
{
    /// <summary>未提交变更最多展示的行数（超出截断并提示剩余条数）。</summary>
    public const int MaxStatusLines = 50;

    /// <summary>最近提交的条数。</summary>
    public const int RecentCommitCount = 5;

    private static readonly TimeSpan GitTimeout = TimeSpan.FromSeconds(5);

    public static async Task<string> CaptureAsync(
        string workingDirectory,
        string gitExecutable = "git",
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(workingDirectory);

        var sb = new StringBuilder();
        sb.AppendLine("## 环境");
        sb.AppendLine($"- 工作目录: {workingDirectory}");

        // 分支是"是否 git 仓库"的探针：非仓库 / 无 git 时 git 非零退出 → 整体省略 git 部分。
        var branch = await RunGitAsync(gitExecutable, GitArgs("branch", "--show-current"),
                workingDirectory, cancellationToken)
            .ConfigureAwait(false);
        if (branch is null || branch.ExitCode != 0)
            return sb.ToString().TrimEnd();

        var branchName = branch.Output.Trim();
        sb.AppendLine(branchName.Length == 0
            ? "- git 分支: (分离头指针 detached HEAD)"
            : $"- git 分支: {branchName}");

        var log = await RunGitAsync(gitExecutable, GitArgs("log", "--oneline", $"-{RecentCommitCount}"),
                workingDirectory, cancellationToken)
            .ConfigureAwait(false);
        if (log is not null && log.ExitCode == 0)
        {
            var lines = NonEmptyLines(log.Output);
            if (lines.Count > 0)
            {
                sb.AppendLine("- 最近提交:");
                foreach (var line in lines)
                    sb.AppendLine($"  - {line}");
            }
        }

        var status = await RunGitAsync(gitExecutable, GitArgs("status", "--short"),
                workingDirectory, cancellationToken)
            .ConfigureAwait(false);
        if (status is not null && status.ExitCode == 0)
        {
            var lines = NonEmptyLines(status.Output);
            if (lines.Count > 0)
            {
                sb.AppendLine($"- 未提交变更 ({lines.Count} 项):");
                foreach (var line in lines.Take(MaxStatusLines))
                    sb.AppendLine($"  {line}");
                var hidden = lines.Count - MaxStatusLines;
                if (hidden > 0)
                    sb.AppendLine($"  …（还有 {hidden} 项未显示）");
            }
        }

        return sb.ToString().TrimEnd();
    }

    /// <summary>git 前缀参数：关闭路径引用转义（core.quotepath），让中文文件名直接可读。</summary>
    private static IReadOnlyList<string> GitArgs(params string[] rest) =>
        ["-c", "core.quotepath=false", .. rest];

    private static async Task<ProcessResult?> RunGitAsync(
        string git, IReadOnlyList<string> args, string workingDirectory, CancellationToken cancellationToken)
    {
        try
        {
            // git 往管道写 UTF-8 字节（实测），与 cmd/python 的 OEM 字节不同，必须显式按 UTF-8 解码。
            return await ProcessRunner.RunAsync(git, args, workingDirectory, GitTimeout, cancellationToken,
                    outputEncoding: Encoding.UTF8)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;   // 外部取消：让上层处理
        }
        catch
        {
            return null;   // git 不存在 / 无法启动 → 静默省略 git 部分
        }
    }

    private static List<string> NonEmptyLines(string text) =>
        text.Replace("\r\n", "\n")
            .Split('\n')
            .Select(l => l.TrimEnd())
            .Where(l => l.Length > 0)
            .ToList();
}
