using System.Runtime.InteropServices;
using Core.AgentLoop;
using Core.Configuration;
using Core.Llm;
using Core.Sessions;
using Core.Skills;
using Core.Tools;
using Di.Cli.Modes;
using Microsoft.Extensions.Configuration;

namespace Di.Cli;

/// <summary>
/// CLI 分派壳（对应 Pi 的 main.ts）：解析参数 → 校验 → 解析模式 → 构建宿主 → 分派到各模式执行器。
/// 不碰 Console —— 输入输出流与 TTY 探测全部由调用方（Program.cs / 测试）传入，
/// 因此可在任意宿主中重放，也可用别的语言按同一契约重写（见 docs/cli.md）。
/// </summary>
public sealed class CliApp
{
    private readonly Func<CliArgs, string, TextWriter, bool, CliHost> _hostFactory;

    public CliApp(Func<CliArgs, string, TextWriter, bool, CliHost>? hostFactory = null)
        => _hostFactory = hostFactory ?? CliHost.Create;

    /// <summary>运行一次 CLI 调用，返回进程退出码（0 = 成功，1 = 用法/运行错误）。</summary>
    public async Task<int> RunAsync(string[] args, TextReader stdin, TextWriter stdout, TextWriter stderr,
        bool stdinTty, bool stdoutTty, CancellationToken cancellationToken = default,
        InterruptCoordinator? interrupt = null)
    {
        ArgumentNullException.ThrowIfNull(args);
        ArgumentNullException.ThrowIfNull(stdin);
        ArgumentNullException.ThrowIfNull(stdout);
        ArgumentNullException.ThrowIfNull(stderr);

        var (cliArgs, diagnostics) = CliArgsParser.Parse(args);
        if (diagnostics.Any(d => d.IsError))
        {
            foreach (var diagnostic in diagnostics)
                await stderr.WriteLineAsync(diagnostic.Message);
            await stderr.WriteLineAsync("用法: di [选项] [提示词]（--help 查看完整帮助）");
            return 1;
        }

        var mode = CliMode.Resolve(cliArgs, stdinTty, stdoutTty);
        var workspace = Directory.GetCurrentDirectory();
        var useAnsi = stdoutTty && !cliArgs.NoAnsi;

        switch (mode)
        {
            case AppMode.Version:
                await stdout.WriteLineAsync(CliInfo.Version);
                return 0;

            case AppMode.Info:
                return await InfoAsync(cliArgs, workspace, stdout);

            case AppMode.Help:
                await stdout.WriteAsync(CliInfo.HelpText);
                return 0;

            case AppMode.Rpc:
                await stderr.WriteLineAsync("--mode rpc 尚未实现");
                return 1;

            case AppMode.Stats:
                return await StatsAsync(cliArgs.Stats, stdout, stderr, cancellationToken);

            default:
                // 需要真实运行的路径：构建宿主（组合根）后分派；宿主释放工具会话与 DI 容器。
                using (var host = _hostFactory(cliArgs, workspace, stderr, useAnsi))
                {
                    return mode switch
                    {
                        AppMode.ListModels => await ListModelsAsync(host, cliArgs.ListModels, stdout, cancellationToken),
                        AppMode.SkillEval => await SkillEvalAsync(host, cliArgs.SkillEval, stdout, stderr, cancellationToken),
                        AppMode.Interactive => await InteractiveAsync(host, stdin, stdout, interrupt, cancellationToken),
                        _ => await PrintMode.RunAsync(host, cliArgs, stdin, stdout, stderr, cancellationToken),
                    };
                }
        }
    }

    /// <summary>
    /// 打印环境 / 构建 / 生效配置信息（短路径，不建 DI）：验证安装的二进制是否最新、
    /// 生效的 MaxIterations / 模型 / provider 来自哪里。历史教训：旧二进制的
    /// <c>AgentLoop:MaxIterations</c> 是 8，headless 跑到 8 轮就截断，用户却看不出二进制过期。
    /// 命令行覆盖（--model/--provider/--thinking）与 <see cref="CliHost.Create"/> 保持一致地标注。
    /// </summary>
    private static async Task<int> InfoAsync(CliArgs args, string workspace, TextWriter stdout)
    {
        var diHome = DiHome.Resolve();
        var configuration = DiConfig.Load(workspace, diHome.RootDirectory);

        var agentLoop = new AgentLoopOptions();
        configuration.GetSection("AgentLoop").Bind(agentLoop);
        var modelOptions = new ModelOptions();
        configuration.GetSection("Model").Bind(modelOptions);

        // single-file 自包含发布下 Assembly.Location 为空串（IL3000），用进程真实路径（di.exe）。
        var assemblyPath = Environment.ProcessPath
            ?? Path.Combine(AppContext.BaseDirectory, $"{CliInfo.Name}.exe");
        var builtAt = File.Exists(assemblyPath) ? File.GetLastWriteTimeUtc(assemblyPath) : (DateTimeOffset?)null;
        var os = OperatingSystem.IsWindows() ? "Windows" : OperatingSystem.IsLinux() ? "Linux" : "macOS";
        var maxIterationsConfigured = configuration.GetValue<int?>("AgentLoop:MaxIterations", null);

        var effectiveProvider = !string.IsNullOrWhiteSpace(args.Provider) ? args.Provider : modelOptions.Provider;
        var effectiveModel = args.Model ?? modelOptions.DefaultModel;

        await stdout.WriteLineAsync("di —— 简洁的 ReAct 编码助手（harness）");
        await stdout.WriteLineAsync($"版本:        {CliInfo.Version}");
        await stdout.WriteLineAsync($"运行时:      {RuntimeInformation.FrameworkDescription}（{os}）");
        await stdout.WriteLineAsync($"可执行文件:  {assemblyPath}" +
            (builtAt is { } t ? $"  （构建于 {t:yyyy-MM-dd HH:mm} UTC）" : ""));
        await stdout.WriteLineAsync($"工作区:      {workspace}");
        await stdout.WriteLineAsync($"Di 家目录:   {diHome.RootDirectory}");
        await stdout.WriteLineAsync($"Shell 工具:  {CoreTools.PlatformShellName}  （Windows 用 cmd.exe，其他平台用 bash）");
        await stdout.WriteLineAsync();
        await stdout.WriteLineAsync("配置源（后加载覆盖先加载）:");
        await stdout.WriteLineAsync($"  内置 appsettings.json             {Path.Combine(AppContext.BaseDirectory, "appsettings.json")}");
        await stdout.WriteLineAsync($"  用户 ~/.di/config.json            {diHome.ConfigFile}" +
            (File.Exists(diHome.ConfigFile) ? "  存在" : "  不存在"));
        await stdout.WriteLineAsync($"  项目 <workspace>/.di/config.json  {DiHome.ProjectConfigFile(workspace)}" +
            (File.Exists(DiHome.ProjectConfigFile(workspace)) ? "  存在" : "  不存在"));
        var diHomeEnv = Environment.GetEnvironmentVariable(DiHome.EnvVariableName);
        await stdout.WriteLineAsync($"  环境变量 DI_HOME                  {(string.IsNullOrWhiteSpace(diHomeEnv) ? "（未设置）" : diHomeEnv)}");
        await stdout.WriteLineAsync();
        await stdout.WriteLineAsync("生效配置（含命令行覆盖）:");
        await stdout.WriteLineAsync($"  AgentLoop:MaxIterations     {agentLoop.MaxIterations}  " +
            (maxIterationsConfigured is null ? "（来源: 默认值）" : "（来源: 配置显式覆盖）"));
        await stdout.WriteLineAsync($"  AgentLoop:HistoryBudgetRatio {agentLoop.HistoryBudgetRatio:F2}");
        await stdout.WriteLineAsync($"  AgentLoop:ReasoningEffort   {(string.IsNullOrWhiteSpace(agentLoop.ReasoningEffort) ? "未设置" : agentLoop.ReasoningEffort)}" +
            (string.IsNullOrWhiteSpace(args.Thinking) ? "" : $"   ← --thinking 覆盖为 {args.Thinking}"));
        await stdout.WriteLineAsync($"  Model:Provider              {effectiveProvider}" +
            (string.IsNullOrWhiteSpace(args.Provider) ? "" : "   ← --provider 覆盖"));
        await stdout.WriteLineAsync($"  Model:DefaultModel          {effectiveModel}" +
            (string.IsNullOrWhiteSpace(args.Model) ? "" : "   ← --model 覆盖"));
        return 0;
    }

    /// <summary>
    /// 用带标签用例集（JSON 数组，<c>{"message", "expected_skills"}</c>）评估当前 skill 匹配器：
    /// 精确率 / 召回率 / 无匹配率 / 平均上下文 token。触发与排除测试即对应的标签用例。
    /// 依赖宿主（复用与生产一致的 <see cref="CliHost.Skills"/> 发现结果）。
    /// </summary>
    private static async Task<int> SkillEvalAsync(CliHost host, string? casesPath, TextWriter stdout,
        TextWriter stderr, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(casesPath))
        {
            await stderr.WriteLineAsync("用法: di --skill-eval <cases.json>");
            return 1;
        }

        IReadOnlyList<SkillTestCase> cases;
        try
        {
            cases = SkillCaseLoader.Load(casesPath, msg => stderr.WriteLine($"  ⚠ {msg}"));
        }
        catch (Exception ex)
        {
            await stderr.WriteLineAsync($"✗ 无法加载用例文件: {ex.Message}");
            return 1;
        }
        if (cases.Count == 0)
        {
            await stderr.WriteLineAsync("✗ 用例文件为空（全部条目被跳过）");
            return 1;
        }

        var metrics = SkillEvaluator.Evaluate(new LexicalSkillMatcher(), host.Skills, cases);
        await stdout.WriteLineAsync($"用例数: {cases.Count}");
        await stdout.WriteLineAsync($"精确率: {metrics.Precision:F3}");
        await stdout.WriteLineAsync($"召回率: {metrics.Recall:F3}");
        await stdout.WriteLineAsync($"无匹配率: {metrics.NoMatchRate:F3}");
        await stdout.WriteLineAsync($"平均上下文 token/回合: {metrics.AverageContextTokens:F0}");
        return 0;
    }

    /// <summary>
    /// 聚合一个会话 JSONL（离线，无需构建宿主）：回合数、token 用量、缓存命中率、总成本。
    /// 会话级命中率 = Σcache_read ÷ Σ计费输入，让"SC 布局是否最优"从论证变成数字。
    /// </summary>
    private static async Task<int> StatsAsync(string? path, TextWriter stdout, TextWriter stderr,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            await stderr.WriteLineAsync("用法: di --stats <会话.jsonl>");
            return 1;
        }
        if (!File.Exists(path))
        {
            await stderr.WriteLineAsync($"✗ 会话文件不存在: {path}");
            return 1;
        }

        SessionStatsSummary stats;
        try
        {
            stats = SessionStats.Aggregate(path);
        }
        catch (Exception ex)
        {
            await stderr.WriteLineAsync($"✗ 无法解析会话文件: {ex.Message}");
            return 1;
        }
        if (stats.Turns == 0)
        {
            await stderr.WriteLineAsync("✗ 未找到任何 task_complete 记录（这不是一次有效会话）");
            return 1;
        }

        await stdout.WriteLineAsync($"回合数: {stats.Turns}");
        await stdout.WriteLineAsync($"输入 token: {stats.InputTokens}（缓存命中 {stats.CacheReadTokens}，命中率 {stats.CacheHitRate:P1}）");
        await stdout.WriteLineAsync($"输出 token: {stats.OutputTokens}");
        if (stats.TotalCost is { } cost)
            await stdout.WriteLineAsync($"总成本: ${cost:F4}");
        return 0;
    }

    /// <summary>交互 REPL：stdin 经流式行读取器喂给 Repl，stdout 渲染。</summary>
    private static async Task<int> InteractiveAsync(CliHost host, TextReader stdin, TextWriter stdout,
        InterruptCoordinator? interrupt, CancellationToken cancellationToken)
    {
        var repl = new Repl(host.Runner, host.Bus, new StreamLineReader(stdin), stdout,
            host.ReplOptions, host.SessionLog, host.Skills, interrupt: interrupt);
        await repl.RunAsync(cancellationToken);
        return 0;
    }

    /// <summary>列出模型目录（咨询性、尽力而为）；带 pattern 时按 id/provider 子串过滤。</summary>
    private static Task<int> ListModelsAsync(CliHost host, string? pattern, TextWriter stdout,
        CancellationToken cancellationToken)
    {
        var models = host.Llm.ListModels();
        if (!string.IsNullOrWhiteSpace(pattern))
        {
            models = models
                .Where(m => m.Id.Contains(pattern, StringComparison.OrdinalIgnoreCase)
                            || m.Provider.Contains(pattern, StringComparison.OrdinalIgnoreCase))
                .ToList();
        }
        foreach (var model in models.OrderBy(m => m.Provider, StringComparer.Ordinal).ThenBy(m => m.Id, StringComparer.Ordinal))
            stdout.WriteLine($"{model.Provider}/{model.Id}  {model.Name}");
        if (models.Count == 0)
            stdout.WriteLine("（无可用模型 —— 检查 provider 配置与网络）");
        return Task.FromResult(0);
    }
}
