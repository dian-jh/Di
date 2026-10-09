using Di.Cli;

namespace Di.Cli.Tests.Configuration;

/// <summary>
/// 针对 <see cref="DiConfig"/>（分层配置合并）的单元测试。
/// 优先级：appsettings.json（构建内默认）→ ~/.di/config.json（用户）→ .di/config.json（项目）
/// → 环境变量。后加载覆盖先加载。
/// </summary>
public sealed class DiConfigTests : IDisposable
{
    private readonly string _home = Directory.CreateTempSubdirectory("di-config-home-").FullName;
    private readonly string _workspace = Directory.CreateTempSubdirectory("di-config-ws-").FullName;
    private readonly string? _savedModelEnv = Environment.GetEnvironmentVariable("Model__DefaultModel");

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("Model__DefaultModel", _savedModelEnv);
        try { Directory.Delete(_home, recursive: true); } catch { }
        try { Directory.Delete(_workspace, recursive: true); } catch { }
    }

    private void WriteJson(string path, string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
    }

    [Fact]
    public void Load_AppSettingsDefaults_AreLoaded()
    {
        // appsettings.json（随构建拷贝）里 DeepSeek:DefaultReasoningEffort = "high"
        var config = DiConfig.Load(_workspace, _home);

        Assert.Equal("high", config["DeepSeek:DefaultReasoningEffort"]);
    }

    [Fact]
    public void Load_UserConfigOverridesAppSettingsDefaults()
    {
        WriteJson(Path.Combine(_home, "config.json"),
            """{"DeepSeek":{"DefaultReasoningEffort":"low"}}""");

        var config = DiConfig.Load(_workspace, _home);

        Assert.Equal("low", config["DeepSeek:DefaultReasoningEffort"]);
    }

    [Fact]
    public void Load_ProjectConfigOverridesUserConfig()
    {
        WriteJson(Path.Combine(_home, "config.json"),
            """{"Model":{"DefaultModel":"home-model"}}""");
        WriteJson(Path.Combine(_workspace, ".di", "config.json"),
            """{"Model":{"DefaultModel":"proj-model"}}""");

        var config = DiConfig.Load(_workspace, _home);

        Assert.Equal("proj-model", config["Model:DefaultModel"]);
    }

    [Fact]
    public void Load_EnvironmentOverridesFileConfig()
    {
        WriteJson(Path.Combine(_home, "config.json"),
            """{"Model":{"DefaultModel":"home-model"}}""");
        Environment.SetEnvironmentVariable("Model__DefaultModel", "env-model");

        var config = DiConfig.Load(_workspace, _home);

        Assert.Equal("env-model", config["Model:DefaultModel"]);
    }

    [Fact]
    public void Load_MissingConfigs_IsHarmless_AndCreatesNothing()
    {
        var config = DiConfig.Load(_workspace, _home);

        Assert.Null(config["Model:DefaultModel"]);
        Assert.False(File.Exists(Path.Combine(_home, "config.json")));
        Assert.False(File.Exists(Path.Combine(_workspace, ".di", "config.json")));
    }
}
