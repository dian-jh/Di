using System.Diagnostics;

namespace Di.Cli;

/// <summary>
/// 交互模式的前端抉择（M4）：默认把控制台交给 TS TUI（node 子进程，继承 stdio），
/// 不可用时回退 C# REPL。外部依赖（环境变量 / 入口解析 / node 探测 / spawn）全部经
/// <see cref="Context"/> 注入，测试不开真实进程（见 Di.Cli.Tests/TuiLauncherTests.cs）。
/// 规则：DI_UI=repl（精确匹配）强制用 REPL；否则 DI_TUI（文件或含 dist/main.js 的目录）
/// ?? ~/.di/tui/dist/main.js 且 node 可解析 → 交 TUI。spawn 异常 / 非零退出 → 回退 REPL。
/// </summary>
public static class TuiLauncher
{
    /// <summary>默认 TUI 安装位置（相对家目录）：install.* 构建并复制到 ~/.di/tui。</summary>
    public const string DefaultRelativeEntry = ".di/tui/dist/main.js";

    /// <summary>抉择结果：Managed=true 表示 TUI 已接管控制台并正常退出（ExitCode 为其退出码）；
    /// false 表示调用方应回退 REPL，<see cref="FallbackReason"/> 给出一条 stderr 提示。</summary>
    public readonly record struct Decision(bool Managed, int ExitCode, string? FallbackReason);

    /// <summary>依赖注入点（生产用真实默认值；测试替换为 fake）。</summary>
    public sealed class Context
    {
        /// <summary>取环境变量（默认 <see cref="Environment.GetEnvironmentVariable(string?)"/>）。</summary>
        public Func<string, string?> GetEnv { get; init; } = Environment.GetEnvironmentVariable;

        /// <summary>家目录（win32 用 USERPROFILE，退回 HOME）；默认入口 ~/.di/tui/dist/main.js 的基准。</summary>
        public string? UserHome { get; init; }

        /// <summary>入口解析（入参 DI_TUI 值 → 入口文件路径；null 表示未解析到）。
        /// 默认规则：DI_TUI 是文件 → 即入口；是目录 → 目录/dist/main.js；否则解释失败。
        /// 覆盖此委托可完全隔离文件系统。</summary>
        public Func<string, string?>? ResolveEntry { get; init; }

        /// <summary>node 可解析探测（默认 spawn node --version）。</summary>
        public Func<bool>? NodeAvailable { get; init; }

        /// <summary>spawn node &lt;entry&gt;（继承 stdio，等待退出）→ 退出码；异常视为 spawn 失败。</summary>
        public Func<string, int>? Spawn { get; init; }
    }

    /// <summary>作出抉择并（若可用）实际拉起 TUI；调用方据 <see cref="Decision.Managed"/> 决定是否回退 REPL。</summary>
    public static Decision TryLaunch(Context? context = null)
    {
        var ctx = context ?? new Context();

        // 逃生门：DI_UI=repl（精确匹配）→ 强制使用 C# REPL，绝不开 TUI。
        if (string.Equals(ctx.GetEnv("DI_UI"), "repl", StringComparison.Ordinal))
            return new Decision(false, 0, "DI_UI=repl，使用 REPL");

        // 入口解析：DI_TUI（文件 / 含 dist/main.js 的目录）?? ~/.di/tui/dist/main.js。
        var (entry, shown) = ResolveEntry(ctx);
        if (entry is null)
            return new Decision(false, 0, $"未找到 TUI 入口（{shown}），回退 REPL");

        // node 可解析探测（此时尚未开 TUI 进程）。
        if (!(ctx.NodeAvailable?.Invoke() ?? ProbeNode()))
            return new Decision(false, 0, "未找到 node，回退 REPL");

        // spawn node <entry>：继承 stdio（不重定向 —— TUI 必须拥有控制台），等待退出。
        try
        {
            var exitCode = (ctx.Spawn ?? SpawnTui)(entry);
            if (exitCode != 0)
                return new Decision(false, exitCode, $"TUI 退出（exit {exitCode}），回退 REPL");
            return new Decision(true, exitCode, null);
        }
        catch (Exception ex)
        {
            return new Decision(false, 0, $"启动 TUI 失败（{ex.Message}），回退 REPL");
        }
    }

    /// <summary>入口解析；返回 (入口文件, 展示用路径，缺失时的提示用)。</summary>
    private static (string? Entry, string Shown) ResolveEntry(Context ctx)
    {
        if (ctx.ResolveEntry is { } custom)
            return (custom(ctx.GetEnv("DI_TUI") ?? ""), "(DI_TUI)");

        var diTui = ctx.GetEnv("DI_TUI");
        if (!string.IsNullOrWhiteSpace(diTui))
        {
            if (File.Exists(diTui))
                return (Path.GetFullPath(diTui), diTui);

            var dirEntry = Path.Combine(diTui, "dist", "main.js");
            if (Directory.Exists(diTui) && File.Exists(dirEntry))
                return (Path.GetFullPath(dirEntry), dirEntry);

            return (null, diTui);
        }

        var home = ctx.UserHome ?? ctx.GetEnv("USERPROFILE") ?? ctx.GetEnv("HOME");
        if (string.IsNullOrWhiteSpace(home))
            return (null, "~/.di/tui/dist/main.js");

        var defaultEntry = Path.Combine(home, DefaultRelativeEntry);
        return File.Exists(defaultEntry)
            ? (Path.GetFullPath(defaultEntry), defaultEntry)
            : (null, defaultEntry);
    }

    /// <summary>默认 node 探测：spawn node --version（短超时，失败即视为不可用）。</summary>
    private static bool ProbeNode()
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "node",
                Arguments = "--version",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            });
            if (process is null)
                return false;
            process.WaitForExit(5000);
            return process.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>默认 spawn：node &lt;entry&gt;，继承 stdio（TUI 拥有控制台），等待退出返回退出码。</summary>
    private static int SpawnTui(string entry)
    {
        var startInfo = new ProcessStartInfo { FileName = "node", UseShellExecute = false };
        startInfo.ArgumentList.Add(entry);
        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("无法启动 node 进程");
        process.WaitForExit();
        return process.ExitCode;
    }
}