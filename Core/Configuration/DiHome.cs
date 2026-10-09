namespace Core.Configuration;

/// <summary>
/// Di 家目录（~/.di）的单一来源。所有用户级子路径（配置、会话、skills、MCP……）由它派发，
/// 各子系统不再各自拼路径。根目录可用环境变量 <c>DI_HOME</c> 覆盖（测试、多环境隔离）。
/// 对齐主流 agent：Claude Code 用 ~/.claude，Codex 用 ~/.codex。
/// </summary>
public sealed class DiHome
{
    public const string EnvVariableName = "DI_HOME";

    /// <summary>家目录根（绝对路径）。</summary>
    public string RootDirectory { get; }

    private DiHome(string rootDirectory)
    {
        RootDirectory = rootDirectory ?? throw new ArgumentNullException(nameof(rootDirectory));
    }

    /// <summary>解析默认家目录：<see cref="EnvVariableName"/> 环境变量优先，否则 ~/.di。</summary>
    public static DiHome Resolve()
    {
        var env = Environment.GetEnvironmentVariable(EnvVariableName);
        return string.IsNullOrWhiteSpace(env)
            ? new DiHome(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".di"))
            : new DiHome(env);
    }

    /// <summary>显式指定根目录（测试 / 宿主注入）。</summary>
    public static DiHome Resolve(string rootDirectory) => new(rootDirectory);

    /// <summary>用户全局配置文件（可选，用户自己写；程序不创建、不覆盖）。</summary>
    public string ConfigFile => Path.Combine(RootDirectory, "config.json");

    /// <summary>会话记录目录（SessionLog 写入，程序创建）。</summary>
    public string SessionsDirectory => Path.Combine(RootDirectory, "sessions");

    /// <summary>用户 skills 目录（将来：<c>skills/&lt;name&gt;/SKILL.md</c>）。</summary>
    public string SkillsDirectory => Path.Combine(RootDirectory, "skills");

    /// <summary>用户斜杠命令目录（将来：<c>commands/&lt;name&gt;.md</c>）。</summary>
    public string CommandsDirectory => Path.Combine(RootDirectory, "commands");

    /// <summary>子代理定义目录（将来：<c>agents/&lt;name&gt;.md</c>）。</summary>
    public string AgentsDirectory => Path.Combine(RootDirectory, "agents");

    /// <summary>MCP 服务器配置（将来：JSON 数组，每个 server 一个条目）。</summary>
    public string McpConfigFile => Path.Combine(RootDirectory, "mcp.json");

    /// <summary>项目级配置目录（&lt;workspace&gt;/.di/，随仓库走）。</summary>
    public static string ProjectDirectory(string workspace) => Path.Combine(workspace, ".di");

    /// <summary>项目级配置文件（&lt;workspace&gt;/.di/config.json，团队共享）。</summary>
    public static string ProjectConfigFile(string workspace) => Path.Combine(ProjectDirectory(workspace), "config.json");
}
