using Core.Configuration;

namespace Di.Tests.Configuration;

/// <summary>
/// 针对 <see cref="DiHome"/>（家目录单一来源）的单元测试。
/// 环境变量测试用 save/restore 包住，避免污染其它测试。
/// </summary>
public sealed class DiHomeTests : IDisposable
{
    private readonly string? _saved = Environment.GetEnvironmentVariable(DiHome.EnvVariableName);

    public void Dispose() => Environment.SetEnvironmentVariable(DiHome.EnvVariableName, _saved);

    [Fact]
    public void Resolve_ExplicitPath_ReturnsThatPath()
    {
        var home = DiHome.Resolve(@"C:\tmp\di-home");

        Assert.Equal(@"C:\tmp\di-home", home.RootDirectory);
    }

    [Fact]
    public void Resolve_EnvVariableOverridesDefault()
    {
        var dir = Directory.CreateTempSubdirectory("di-home-").FullName;
        try
        {
            Environment.SetEnvironmentVariable(DiHome.EnvVariableName, dir);

            var home = DiHome.Resolve();

            Assert.Equal(dir, home.RootDirectory);
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void Resolve_Default_IsUserProfileDotDi()
    {
        Environment.SetEnvironmentVariable(DiHome.EnvVariableName, null);

        var home = DiHome.Resolve();

        Assert.Equal(
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".di"),
            home.RootDirectory);
    }

    [Fact]
    public void SubPaths_AreDerivedFromRoot()
    {
        var home = DiHome.Resolve(@"C:\tmp\di-home");

        Assert.Equal(@"C:\tmp\di-home\config.json", home.ConfigFile);
        Assert.Equal(@"C:\tmp\di-home\sessions", home.SessionsDirectory);
        Assert.Equal(@"C:\tmp\di-home\skills", home.SkillsDirectory);
        Assert.Equal(@"C:\tmp\di-home\commands", home.CommandsDirectory);
        Assert.Equal(@"C:\tmp\di-home\agents", home.AgentsDirectory);
        Assert.Equal(@"C:\tmp\di-home\mcp.json", home.McpConfigFile);
    }

    [Fact]
    public void ProjectConfigFile_IsWorkspaceDotDiConfig()
    {
        Assert.Equal(
            Path.Combine("C:\\ws", ".di", "config.json"),
            DiHome.ProjectConfigFile("C:\\ws"));
    }
}
