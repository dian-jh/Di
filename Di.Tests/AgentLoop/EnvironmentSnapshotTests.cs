using System.Diagnostics;
using Core.AgentLoop;
using Di.Tests.Tools;

namespace Di.Tests.AgentLoop;

/// <summary>
/// 针对 <see cref="EnvironmentSnapshot"/>（环境感知快照，最小化注入 + 工具自取）的测试。
/// 设计对齐 pi（参考 E:\Agent\PI\pi 的 system-prompt.ts / footer-data-provider.ts）：
/// 「最小化注入 + 工具自取」——提示词里只注入工作目录与一行自取提示，不注入 git 分支 /
/// 改动 / 提交（低频易变信息改为模型需要时用 bash 自取）；git 分支的用户可见展示归 UI 层。
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
    public async Task Capture_ReturnsWorkingDirectoryAndSelfFetchHint()
    {
        var text = await EnvironmentSnapshot.CaptureAsync(_base);

        Assert.Contains("工作目录", text);
        Assert.Contains(_base, text);
        // 自取提示：仓库详情（分支/改动/提交）不再注入，改为教模型用 bash 自助查询。
        Assert.Contains("git status --short -b", text);
        // 旧版注入格式必须绝迹：git 分支 / 变更列表 / 提交列表。
        Assert.DoesNotContain("- git 分支:", text);
        Assert.DoesNotContain("- 未提交变更", text);
        Assert.DoesNotContain("- 最近提交:", text);
    }

    [Fact]
    public async Task Capture_GitRepo_DoesNotInjectBranchCommitsChanges()
    {
        if (Git is null) return;
        var repo = InitRepo("repo");
        WriteGit(repo, "readme.md", "# hi");
        RunGit(repo, "add", "readme.md");
        RunGit(repo, "commit", "-m", "init");
        File.WriteAllText(Path.Combine(repo, "untracked.txt"), "x");

        var text = await EnvironmentSnapshot.CaptureAsync(repo);

        // 最小化注入：即使仓库真实存在，分支/提交/变更也不进提示词（模型需要时用 bash 自取）。
        Assert.Contains("工作目录", text);
        Assert.DoesNotContain("- git 分支:", text);
        Assert.DoesNotContain("- 最近提交:", text);
        Assert.DoesNotContain("- 未提交变更", text);
        Assert.DoesNotContain("init", text);   // 提交信息也不得漏进快照
    }

    [Fact]
    public async Task Capture_NullOrWhitespaceWorkingDirectory_Throws()
    {
        await Assert.ThrowsAsync<ArgumentException>(() => EnvironmentSnapshot.CaptureAsync(""));
        await Assert.ThrowsAsync<ArgumentException>(() => EnvironmentSnapshot.CaptureAsync("   "));
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