using Core.Configuration;
using Microsoft.Extensions.Configuration;

namespace Di.Cli;

/// <summary>
/// Di 的分层配置装配。源与优先级（后加载覆盖先加载）：
/// <list type="number">
/// <item>appsettings.json（构建内默认，随 exe 走）</item>
/// <item>~/.di/config.json（用户全局，用户自己写）</item>
/// <item>&lt;workspace&gt;/.di/config.json（项目级，随仓库走，团队共享）</item>
/// <item>环境变量（运行时覆盖）</item>
/// </list>
/// 全部灌进同一个 <see cref="IConfiguration"/>，各 Options 的 BindConfiguration 自动生效。
/// 所有权规则：只有会话记录由程序写（sessions/），配置文件一律程序只读。
/// </summary>
public static class DiConfig
{
    public static IConfiguration Load(string workspace, string homeRoot)
    {
        return new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: true, reloadOnChange: false)
            .AddJsonFile(Path.Combine(homeRoot, "config.json"), optional: true, reloadOnChange: false)
            .AddJsonFile(DiHome.ProjectConfigFile(workspace), optional: true, reloadOnChange: false)
            .AddEnvironmentVariables()
            .Build();
    }
}
