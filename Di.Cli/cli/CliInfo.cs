using System.Reflection;

namespace Di.Cli;

/// <summary>
/// CLI 的展示元数据：版本号与 --help 文本。
/// 版本号从程序集信息读取（csproj 的 <c>&lt;Version&gt;</c> 写入 AssemblyInformationalVersion），
/// 不硬编码字符串，避免与打包配置漂移。
/// </summary>
public static class CliInfo
{
    /// <summary>全局命令名（也是产物名 di.exe）。</summary>
    public const string Name = "di";

    /// <summary>版本号（AssemblyInformationalVersion；含 +commit 后缀时截断）。</summary>
    public static string Version { get; } = ReadVersion();

    /// <summary>--help 的完整用法文本。</summary>
    public static string HelpText { get; } = """
        di —— 简洁的 ReAct 编码助手（harness）

        用法: di [选项] [提示词...]

        headless 单发（给一个提示词即跑一个回合后退出）：
          di "读一下 README"               文本输出（默认）
          di --mode json "分析这个函数"      JSON 输出（脚本友好，单文档）
          echo "总结" | di                 无位置参数时从 stdin 读提示词

        交互模式：
          di                               进入 REPL（斜杠命令: /help /model /skills /clear /exit）

        ChatGPT（官方 OAuth，无需 API Key）：
          di auth chatgpt login             Continue with ChatGPT（复用已有注册）
          di auth chatgpt login --new       注册另一账户或 workspace
          di auth chatgpt login --consent   重新申请 ChatGPT plan 授权
          di auth chatgpt status            查看登录状态
          di auth chatgpt models            获取当前账户可用模型
          di auth chatgpt logout             撤销并退出
          di --provider chatgpt --model <slug> "你好"
          /model                            查看当前模型和目录
          /model chatgpt/<slug>              会话内跨 provider 切换
          /model --refresh                   刷新已配置 provider 的模型目录

        选项：
          -m, --model <名>      指定模型（覆盖配置 Model:DefaultModel）
          --provider <id>       指定 provider（覆盖配置 Model:Provider）
          --mode <模式>         interactive / print / json / rpc
          --print               强制文本单发
          --thinking <级别>      推理强度（透传）
          --list-models [pat]   列出可用模型（可按 id/provider 过滤）
          --stats <文件>         聚合一个会话 JSONL 的用量 / 缓存命中率 / 成本
          --skill-eval <文件>    用带标签用例集评估 skill 匹配器（精确率 / 召回率）
          --no-session          headless 不写会话日志（默认写入 ~/.di/sessions/）
          --no-ansi             禁用 ANSI 控制序列（脚本友好）
          -h, --help            显示本帮助
          --version             显示版本
          --info                打印环境 / 构建 / 生效配置（诊断：验证安装的二进制是否为最新）

        配置: ~/.di/config.json 与 &lt;workspace&gt;/.di/config.json（JSON，覆盖 appsettings 默认值）。
        """;

    private static string ReadVersion()
    {
        var info = typeof(CliInfo).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (string.IsNullOrWhiteSpace(info))
            return "0.0.0";
        var plus = info.IndexOf('+');
        return plus >= 0 ? info[..plus] : info;
    }
}
