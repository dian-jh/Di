using System.Diagnostics;
using Core.AgentLoop;
using Di.Tests.Tools;

namespace Di.Tests.AgentLoop;

/// <summary>
/// 针对 <see cref="EnvironmentSnapshot"/>（环境感知快照/状态栏技术）的测试。
/// 覆盖：非 git 目录只含工作目录、git 缺失不抛异常、真实仓库含分支/提交/变更、
/// 中文提交信息不乱码（git 写 UTF-8）、变更概览截断。
/// 依赖真实 git 的用例在 testhost 找不到 git 时静默跳过（与 FindPython 同款策略）。
/// </summary>
public sealed class EnvironmentSnapshotTests : IDisposable
{
    private static readonly string? Git = TestEnvironment.FindGit();

    private readonly string _base = Directory.CreateTempSubdirectory("di-env-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_base, recursive: true); } catch { }
    }

    [Fact]
    public async Task Capture_NonGitDirectory_ReturnsWorkingDirectoryOnly()
    {
        var text = await EnvironmentSnapshot.CaptureAsync(_base, Git ?? "git");

        Assert.Contains("工作目录", text);
        Assert.Contains(_base, text);
        Assert.DoesNotContain("git 分支", text);
        Assert.DoesNotContain("最近提交", text);
        Assert.DoesNotContain("未提交变更", text);
    }

    [Fact]
    public async Task Capture_GitExecutableMissing_DoesNotThrow_ReturnsWorkingDirectoryOnly()
    {
        var text = await EnvironmentSnapshot.CaptureAsync(_base, "definitely_not_a_real_git_xyz");

        Assert.Contains("工作目录", text);
        Assert.DoesNotContain("git 分支", text);
    }

    [Fact]
    public async Task Capture_GitRepo_IncludesBranchCommitsAndChanges()
    {
        if (Git is null) return;
        var repo = InitRepo("repo");
        WriteGit(repo, "readme.md", "# hi");
        RunGit(repo, "add", "readme.md");
        RunGit(repo, "commit", "-m", "init");
        File.WriteAllText(Path.Combine(repo, "untracked.txt"), "x");

        var text = await EnvironmentSnapshot.CaptureAsync(repo, Git);

        Assert.Contains("工作目录", text);
        Assert.Contains("git 分支", text);
        Assert.Contains("最近提交", text);
        Assert.Contains("init", text);
        Assert.Contains("未提交变更", text);
        Assert.Contains("untracked.txt", text);
    }

    [Fact]
    public async Task Capture_GitRepo_ChineseCommitMessage_IsNotMojibake()
    {
        if (Git is null) return;
        var repo = InitRepo("zh");
        WriteGit(repo, "a.txt", "1");
        RunGit(repo, "add", "a.txt");
        RunGit(repo, "commit", "-m", "中文提交");

        var text = await EnvironmentSnapshot.CaptureAsync(repo, Git);

        Assert.Contains("中文提交", text);   // git 往管道写 UTF-8，快照必须按 UTF-8 解码
    }

    [Fact]
    public async Task Capture_LargeStatus_IsTruncatedWithMarker()
    {
        if (Git is null) return;
        var repo = InitRepo("big");
        RunGit(repo, "commit", "--allow-empty", "-m", "init");
        var total = EnvironmentSnapshot.MaxStatusLines + 10;
        for (var i = 0; i < total; i++)
            File.WriteAllText(Path.Combine(repo, $"f{i:000}.txt"), "x");

        var text = await EnvironmentSnapshot.CaptureAsync(repo, Git);

        Assert.Contains("未提交变更", text);
        Assert.Contains("还有 10 项未显示", text);
        Assert.DoesNotContain("f050.txt", text);   // 第 50 行之后被截断
    }

    // ---- 工具 ----

    private string InitRepo(string name)
    {
        var dir = Path.Combine(_base, name);
        Directory.CreateDirectory(dir);
        RunGit(dir, "init", "-q");
        RunGit(dir, "config", "user.name", "Test");
        RunGit(dir, "config", "user.email", "test@example.com");
        return dir;
    }

    private static void WriteGit(string dir, string path, string content)
    {
        var full = Path.Combine(dir, path);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, content);
    }

    private void RunGit(string dir, params string[] args)
    {
        var psi = new ProcessStartInfo(Git!, string.Join(' ', args.Select(a => a.Contains(' ') ? $"\"{a}\"" : a)))
        {
            WorkingDirectory = dir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        using var p = Process.Start(psi)!;
        p.WaitForExit(20000);
        Assert.True(p.ExitCode == 0, $"git {string.Join(' ', args)} 失败: {p.StandardError.ReadToEnd()}");
    }
}
