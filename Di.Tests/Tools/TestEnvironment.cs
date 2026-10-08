using System.Diagnostics;

namespace Di.Tests.Tools;

/// <summary>
/// 测试环境助手：在 testhost 里找一个真正可用的 python 解释器。
/// dotnet test 的 testhost 从 Git Bash 继承 PATH（可能不含 python），
/// 因此"裸名 python"不可靠；这里按 PATH → 常见安装目录的顺序探测，
/// 让 PythonTool 的逻辑测试真正跑起来（否则会因找不到解释器而静默跳过）。
/// </summary>
internal static class TestEnvironment
{
    /// <summary>找到一个可用的 python 解释器路径/命令；找不到返回 null。</summary>
    public static string? FindPython()
    {
        foreach (var candidate in Candidates())
        {
            if (TryRunVersion(candidate))
                return candidate;
        }
        return null;
    }

    /// <summary>找到一个可用的 git 路径/命令；找不到返回 null（testhost PATH 可能不含 git）。</summary>
    public static string? FindGit()
    {
        foreach (var candidate in GitCandidates())
        {
            if (TryRunVersion(candidate, "--version"))
                return candidate;
        }
        return null;
    }

    private static IEnumerable<string> GitCandidates()
    {
        yield return "git";
        if (OperatingSystem.IsWindows())
        {
            foreach (var root in new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Git", "cmd"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Git", "cmd"),
            })
            {
                var exe = Path.Combine(root, "git.exe");
                if (File.Exists(exe))
                    yield return exe;
            }
        }
    }

    private static IEnumerable<string> Candidates()
    {
        yield return "python";
        yield return "python3";

        if (OperatingSystem.IsWindows())
        {
            // 用户级安装（%LOCALAPPDATA%\Programs\Python\Python*\python.exe）
            var programs = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "Python");
            if (Directory.Exists(programs))
            {
                foreach (var dir in Directory.GetDirectories(programs, "Python*")
                             .OrderByDescending(d => d, StringComparer.OrdinalIgnoreCase))
                {
                    yield return Path.Combine(dir, "python.exe");
                }
            }
            // 系统级安装
            foreach (var root in new[] { @"C:\Python313", @"C:\Python312", @"C:\Python311", @"C:\Python310", @"C:\Python" })
            {
                var p = Path.Combine(root, "python.exe");
                if (File.Exists(p))
                    yield return p;
            }
        }
    }

    private static bool TryRunVersion(string exe, string versionArg = "--version")
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo(exe, versionArg)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            });
            if (p is null)
                return false;
            p.WaitForExit(5000);
            return p.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }
}
