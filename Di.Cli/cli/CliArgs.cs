namespace Di.Cli;

/// <summary>
/// CLI 参数解析结果 —— <b>纯数据</b>（语言无关契约的一部分）。
/// 解析器不碰 I/O、不碰 Console，只做 string[] → 数据的映射；任何语言的 CLI 重写
/// 都先产出同样的数据形状，再交给 <see cref="CliMode.Resolve"/> 决定运行模式。
/// </summary>
public sealed record CliArgs
{
    /// <summary>位置参数：headless 模式下的提示词（`--` 之后的内容也在这里）。</summary>
    public IReadOnlyList<string> Positionals { get; init; } = [];

    /// <summary>--model / -m：当前模型名。</summary>
    public string? Model { get; init; }

    /// <summary>--provider：provider 路由。</summary>
    public string? Provider { get; init; }

    /// <summary>--print：强制文本单发模式。</summary>
    public bool Print { get; init; }

    /// <summary>--mode：显式运行模式（interactive / print / json / rpc）。</summary>
    public string? Mode { get; init; }

    /// <summary>--version：打印版本后退出。</summary>
    public bool Version { get; init; }

    /// <summary>--info：打印生效配置 / 构建 / 环境信息后退出（诊断"装的二进制是不是旧的"）。</summary>
    public bool Info { get; init; }

    /// <summary>--help / -h：打印帮助后退出。</summary>
    public bool Help { get; init; }

    /// <summary>--list-models [pattern]：列出可用模型。无 pattern 时为空字符串。</summary>
    public string? ListModels { get; init; }

    /// <summary>--stats &lt;file&gt;：聚合一个会话 JSONL 的用量 / 缓存命中率 / 成本。</summary>
    public string? Stats { get; init; }

    /// <summary>--skill-eval &lt;file&gt;：用带标签用例集评估 skill 匹配器（精确率 / 召回率 / 无匹配率）。</summary>
    public string? SkillEval { get; init; }

    /// <summary>--thinking：推理强度（透传）。</summary>
    public string? Thinking { get; init; }

    /// <summary>--no-session：headless 不写会话日志。</summary>
    public bool NoSession { get; init; }

    /// <summary>--resume &lt;file&gt;：载入持久化轨迹并进入交互模式；继续仅在用户输入后发生。</summary>
    public string? Resume { get; init; }

    /// <summary>--no-ansi：禁用 ANSI 控制序列。</summary>
    public bool NoAnsi { get; init; }

    /// <summary>未知旗标（原样保留，诊断已记录）。</summary>
    public IReadOnlyList<string> UnknownFlags { get; init; } = [];
}

/// <summary>一次参数诊断。IsError=true 时调用方应以非零码退出。</summary>
public sealed record CliDiagnostic(string Message, bool IsError = false);

/// <summary>
/// 纯参数解析器（对应 Pi 的 <c>cli/args.ts</c>）。规则：
/// <list type="bullet">
/// <item><c>--</c> 之后的内容全部按位置参数处理，不再解析旗标。</item>
/// <item>带值旗标（--model/--provider/--mode/--thinking）必须跟一个不以 <c>-</c> 开头的值，否则报"缺值"。</item>
/// <item><c>--list-models</c> 可选跟一个 pattern（只吃下一个不以 <c>-</c> 开头的 token）。</item>
/// <item><c>--mode</c> 值域校验（interactive/print/json/rpc），非法值报错。</item>
/// <item>未知旗标记入 <see cref="CliArgs.UnknownFlags"/> 并报错（悲观：不静默忽略）。</item>
/// </list>
/// </summary>
public static class CliArgsParser
{
    private static readonly string[] KnownModes = ["interactive", "print", "json", "rpc"];

    public static (CliArgs Args, IReadOnlyList<CliDiagnostic> Diagnostics) Parse(string[] args)
    {
        var positionals = new List<string>();
        var unknown = new List<string>();
        var diagnostics = new List<CliDiagnostic>();
        string? model = null, provider = null, mode = null, thinking = null, resume = null;
        string? listModels = null, stats = null, skillEval = null;
        bool print = false, version = false, info = false, help = false, noSession = false, noAnsi = false;
        var listModelsSet = false;
        var afterDoubleDash = false;

        for (var i = 0; i < args.Length; i++)
        {
            var token = args[i];

            if (afterDoubleDash)
            {
                positionals.Add(token);
                continue;
            }

            switch (token)
            {
                case "--":
                    afterDoubleDash = true;
                    break;

                case "--version":
                    version = true;
                    break;

                case "--info":
                    info = true;
                    break;

                case "-h":
                case "--help":
                    help = true;
                    break;

                case "--print":
                    print = true;
                    break;

                case "--no-session":
                    noSession = true;
                    break;

                case "--resume":
                    if (TryTakeValue(args, ref i, "--resume", diagnostics, out var resumePath)) resume = resumePath;
                    break;

                case "--no-ansi":
                    noAnsi = true;
                    break;

                case "-m":
                case "--model":
                    if (TryTakeValue(args, ref i, "--model", diagnostics, out var m)) model = m;
                    break;

                case "--provider":
                    if (TryTakeValue(args, ref i, "--provider", diagnostics, out var p)) provider = p;
                    break;

                case "--thinking":
                    if (TryTakeValue(args, ref i, "--thinking", diagnostics, out var t)) thinking = t;
                    break;

                case "--mode":
                    if (TryTakeValue(args, ref i, "--mode", diagnostics, out var m2))
                    {
                        mode = m2;
                        if (!KnownModes.Contains(m2))
                            diagnostics.Add(new CliDiagnostic($"未知模式: --mode {m2}（可选 interactive / print / json / rpc）", IsError: true));
                    }
                    break;

                case "--list-models":
                    listModelsSet = true;
                    listModels = "";
                    // 可选 pattern：只吃下一个不以 '-' 开头的 token，避免吞掉别的旗标。
                    if (i + 1 < args.Length && !args[i + 1].StartsWith('-'))
                        listModels = args[++i];
                    break;

                case "--stats":
                    if (TryTakeValue(args, ref i, "--stats", diagnostics, out var s)) stats = s;
                    break;

                case "--skill-eval":
                    if (TryTakeValue(args, ref i, "--skill-eval", diagnostics, out var se)) skillEval = se;
                    break;

                default:
                    if (token.StartsWith('-'))
                    {
                        unknown.Add(token);
                        diagnostics.Add(new CliDiagnostic($"未知选项: {token}（--help 查看用法）", IsError: true));
                    }
                    else
                    {
                        positionals.Add(token);
                    }
                    break;
            }
        }

        return (new CliArgs
        {
            Positionals = positionals,
            Model = model,
            Provider = provider,
            Print = print,
            Mode = mode,
            Version = version,
            Info = info,
            Help = help,
            ListModels = listModelsSet ? listModels : null,
            Stats = stats,
            SkillEval = skillEval,
            Thinking = thinking,
            NoSession = noSession,
            Resume = resume,
            NoAnsi = noAnsi,
            UnknownFlags = unknown,
        }, diagnostics);
    }

    /// <summary>取旗标的下一个 token 作为值；无值或下一个是旗标时报"缺值"（悲观：不吞旗标）。</summary>
    private static bool TryTakeValue(string[] args, ref int i, string flag,
        List<CliDiagnostic> diagnostics, out string? value)
    {
        if (i + 1 < args.Length && !args[i + 1].StartsWith('-'))
        {
            value = args[++i];
            return true;
        }
        value = null;
        diagnostics.Add(new CliDiagnostic($"选项 {flag} 缺少值", IsError: true));
        return false;
    }
}
