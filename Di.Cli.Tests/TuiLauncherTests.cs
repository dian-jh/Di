using Di.Cli;

namespace Di.Cli.Tests;

/// <summary>
/// <see cref="TuiLauncher"/> 的单元测试：交互前端抉择（TS TUI or 回退 C# REPL）。
/// 全部外部依赖（环境变量 / 入口解析 / node 探测 / spawn）经 <see cref="TuiLauncher.Context"/> 注入，
/// 不开真实进程 —— 真实 node spawn 只存在于生产默认路径。
/// </summary>
public sealed class TuiLauncherTests
{
    /// <summary>记录 spawn 调用与入参；可配置退出码或抛异常（模拟 node 缺失 / 启动失败）。</summary>
    private sealed class FakeSpawner
    {
        public int Calls;
        public string? LastEntry;
        public int Result;
        public Exception? Throw;

        public int Invoke(string entry)
        {
            Calls++;
            LastEntry = entry;
            if (Throw is not null)
                throw Throw;
            return Result;
        }
    }

    /// <summary>环境变量假件：未显式设置的键返回 null。</summary>
    private sealed class FakeEnv : Dictionary<string, string?>
    {
        public string? Get(string name) => TryGetValue(name, out var value) ? value : null;
    }

    private static TuiLauncher.Context Context(FakeEnv env, string? home, FakeSpawner spawner, bool node = true)
        => new()
        {
            GetEnv = env.Get,
            UserHome = home,
            NodeAvailable = () => node,
            Spawn = spawner.Invoke,
        };

    [Fact]
    public void DiUiRepl_ForcesRepl_AndNeverSpawns()
    {
        // 逃生门：DI_UI=repl（精确匹配）→ 强制使用 C# REPL，绝不 spawn TUI。
        var spawner = new FakeSpawner();

        var decision = TuiLauncher.TryLaunch(Context(new FakeEnv { ["DI_UI"] = "repl" }, null, spawner));

        Assert.False(decision.Managed);
        Assert.Contains("DI_UI=repl", decision.FallbackReason);
        Assert.Equal(0, spawner.Calls);
    }

    [Fact]
    public void DefaultEntryMissing_FallsBackToRepl_AndNeverSpawns()
    {
        // 未设 DI_TUI，家目录下也没有 ~/.di/tui/dist/main.js → 不可用，且不开进程。
        var root = Directory.CreateTempSubdirectory("di-tui-");
        try
        {
            var spawner = new FakeSpawner();

            var decision = TuiLauncher.TryLaunch(Context(new FakeEnv(), root.FullName, spawner));

            Assert.False(decision.Managed);
            Assert.Contains("未找到 TUI 入口", decision.FallbackReason);
            Assert.Contains("回退 REPL", decision.FallbackReason);
            Assert.Equal(0, spawner.Calls);
        }
        finally
        {
            Directory.Delete(root.FullName, recursive: true);
        }
    }

    [Fact]
    public void DiTuiEntryFile_LaunchesTui_AndPropagatesExitCode()
    {
        // DI_TUI 指向入口文件 + node 可用 + spawn 返回 0 → 接管控制台，退出码 0 原样传播。
        var root = Directory.CreateTempSubdirectory("di-tui-");
        try
        {
            var entry = Path.Combine(root.FullName, "main.js");
            File.WriteAllText(entry, "// tui");
            var spawner = new FakeSpawner { Result = 0 };

            var decision = TuiLauncher.TryLaunch(Context(new FakeEnv { ["DI_TUI"] = entry }, null, spawner));

            Assert.True(decision.Managed);
            Assert.Equal(0, decision.ExitCode);
            Assert.Equal(1, spawner.Calls);
            Assert.Equal(Path.GetFullPath(entry), Path.GetFullPath(spawner.LastEntry!));
        }
        finally
        {
            Directory.Delete(root.FullName, recursive: true);
        }
    }

    [Fact]
    public void DiTuiDirectory_WithDistMainJs_LaunchesDistEntry()
    {
        // DI_TUI 指向目录 → 回落目录/dist/main.js。
        var root = Directory.CreateTempSubdirectory("di-tui-");
        try
        {
            var distFile = Path.Combine(root.FullName, "dist", "main.js");
            Directory.CreateDirectory(Path.GetDirectoryName(distFile)!);
            File.WriteAllText(distFile, "// tui");
            var spawner = new FakeSpawner { Result = 0 };

            var decision = TuiLauncher.TryLaunch(Context(new FakeEnv { ["DI_TUI"] = root.FullName }, null, spawner));

            Assert.True(decision.Managed);
            Assert.Equal(1, spawner.Calls);
            Assert.Equal(Path.GetFullPath(distFile), Path.GetFullPath(spawner.LastEntry!));
        }
        finally
        {
            Directory.Delete(root.FullName, recursive: true);
        }
    }

    [Fact]
    public void SpawnNonZeroExit_FallsBackToRepl_WithReason()
    {
        // spawn 成功但 TUI 非零退出 → 回退 REPL，如实提示退出码。
        var root = Directory.CreateTempSubdirectory("di-tui-");
        try
        {
            var entry = Path.Combine(root.FullName, "main.js");
            File.WriteAllText(entry, "// tui");
            var spawner = new FakeSpawner { Result = 3 };

            var decision = TuiLauncher.TryLaunch(Context(new FakeEnv { ["DI_TUI"] = entry }, null, spawner));

            Assert.False(decision.Managed);
            Assert.Equal(3, decision.ExitCode);
            Assert.Contains("exit 3", decision.FallbackReason);
            Assert.Equal(1, spawner.Calls);
        }
        finally
        {
            Directory.Delete(root.FullName, recursive: true);
        }
    }

    [Fact]
    public void SpawnThrows_FallsBackToRepl_WithReason()
    {
        // spawn 抛异常（node 缺失 / 入口不可执行等）→ 回退 REPL，提示原因。
        var root = Directory.CreateTempSubdirectory("di-tui-");
        try
        {
            var entry = Path.Combine(root.FullName, "main.js");
            File.WriteAllText(entry, "// tui");
            var spawner = new FakeSpawner { Throw = new InvalidOperationException("node 不在 PATH") };

            var decision = TuiLauncher.TryLaunch(Context(new FakeEnv { ["DI_TUI"] = entry }, null, spawner));

            Assert.False(decision.Managed);
            Assert.Contains("启动 TUI 失败", decision.FallbackReason);
            Assert.Equal(1, spawner.Calls);
        }
        finally
        {
            Directory.Delete(root.FullName, recursive: true);
        }
    }

    [Fact]
    public void NodeMissing_SkipsSpawn_FallsBackToRepl()
    {
        // 入口存在但 node 不可解析 → 回退 REPL，且绝不 spawn。
        var root = Directory.CreateTempSubdirectory("di-tui-");
        try
        {
            var entry = Path.Combine(root.FullName, "main.js");
            File.WriteAllText(entry, "// tui");
            var spawner = new FakeSpawner();

            var decision = TuiLauncher.TryLaunch(Context(new FakeEnv { ["DI_TUI"] = entry }, null, spawner, node: false));

            Assert.False(decision.Managed);
            Assert.Contains("未找到 node", decision.FallbackReason);
            Assert.Equal(0, spawner.Calls);
        }
        finally
        {
            Directory.Delete(root.FullName, recursive: true);
        }
    }
}