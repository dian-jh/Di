using Common.Events;
using Core.AgentLoop;
using Core.Configuration;
using Core.ContextManagement;
using Core.Llm;
using Core.Logging;
using Core.Sessions;
using Core.Skills;
using Core.Tools;
using Di.Cli.Commands;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Di.Cli;

/// <summary>
/// 组合根：把配置 / DI / 工具 / skills / 会话日志 / AgentRunner 装配成一个 <see cref="CliHost"/>，
/// 各模式（交互 / headless / 列模型）从同一个宿主取依赖。
/// <see cref="Create"/> 是唯一的"真实"装配入口（从 Program.cs 迁入）；测试直接构造宿主并注入 fakes。
/// 宿主实现 IDisposable：释放工具执行器（含持久化 shell 会话）与 DI 容器。
/// </summary>
public sealed class CliHost : IDisposable
{
    private readonly IDisposable? _disposer;

    /// <summary>会话驱动 API（harness 层稳定契约，见 Core.AgentLoop）。</summary>
    public IAgentRunner Runner { get; }

    /// <summary>ReAct 循环事件总线（UI / 会话记录从同一总线消费）。</summary>
    public IEventBus Bus { get; }

    /// <summary>模型层服务（--list-models 用）。</summary>
    public ILlmService Llm { get; }

    /// <summary>已发现的 skills（用户级 + 项目级合并，项目覆盖同名用户级）。</summary>
    public IReadOnlyList<Skill> Skills { get; }

    /// <summary>REPL 展示配置（输出重定向时 UseAnsi 已被置 false）。</summary>
    public ReplOptions ReplOptions { get; }

    /// <summary>
    /// 当前生效的推理强度（模型强度，如 off/low/high/max；启动时由 --thinking / 配置固定）。
    /// 快照语义：强度运行期不可切（预留），与可实时切换的 <see cref="IAgentRunner.CurrentModel"/> 分开存放。
    /// </summary>
    public string? ReasoningEffort { get; }

    /// <summary>会话持久化（headless 单发也写日志；--no-session 时跳过）。</summary>
    public SessionLog? SessionLog { get; }

    /// <summary>
    /// 斜杠命令注册表（内置 + 用户命令，两前端共用同一份）：REPL 与 RPC 模式都从宿主取。
    /// 用户命令来自 <c>~/.di/commands/*.md</c>（<see cref="Create"/> 里加载；测试直接构造宿主时仅内置）。
    /// </summary>
    public SlashCommandRegistry Commands { get; }

    public CliHost(IAgentRunner runner, IEventBus bus, ILlmService llm, IReadOnlyList<Skill> skills,
        ReplOptions replOptions, SessionLog? sessionLog = null, IDisposable? disposer = null,
        SlashCommandRegistry? commands = null, string? reasoningEffort = null)
    {
        Runner = runner ?? throw new ArgumentNullException(nameof(runner));
        Bus = bus ?? throw new ArgumentNullException(nameof(bus));
        Llm = llm ?? throw new ArgumentNullException(nameof(llm));
        Skills = skills ?? throw new ArgumentNullException(nameof(skills));
        ReplOptions = replOptions ?? throw new ArgumentNullException(nameof(replOptions));
        ReasoningEffort = reasoningEffort;
        SessionLog = sessionLog;
        _disposer = disposer;
        Commands = commands ?? BuiltinCommands.CreateRegistry();
    }

    public void Dispose() => _disposer?.Dispose();

    /// <summary>
    /// 真实装配（分层配置 → AddDi() → 工具/skills/sessionLog/AgentRunner）。
    /// CLI 参数里的覆盖项在此生效：--provider 换适配器路由、--model 换默认模型、--thinking 透传。
    /// API Key 不在启动时要求：凭据由模型层在<b>请求时</b>解析，未配置时仅请求路径报错。
    /// </summary>
    public static CliHost Create(CliArgs args, string workspace, TextWriter stderr, bool useAnsi)
    {
        ArgumentNullException.ThrowIfNull(args);
        ArgumentException.ThrowIfNullOrWhiteSpace(workspace);
        ArgumentNullException.ThrowIfNull(stderr);

        var diHome = DiHome.Resolve();
        var configuration = DiConfig.Load(workspace, diHome.RootDirectory);

        var services = new ServiceCollection();
        services.AddDi(configuration);
        var provider = services.BuildServiceProvider();

        // 首次解析触发适配器装配（注册 provider 路由）。
        var llm = provider.GetRequiredService<ILlmService>();

        var agentLoop = provider.GetRequiredService<IOptions<AgentLoopOptions>>().Value;
        var modelOptions = provider.GetRequiredService<IOptions<ModelOptions>>().Value;
        var replOptions = provider.GetRequiredService<IOptions<ReplOptions>>().Value;

        var executor = CoreTools.CreateExecutor(workspace);

        // Skills：标准位置发现（对齐 Agent Skills 规范 / Pi）。源按优先级排列，后面的覆盖前面同名的：
        // 用户 ~/.agents/skills → ~/.di/skills → 项目 .agents/skills 祖先目录（近→远，到 git 根）
        // → <workspace>/.di/skills（项目最高优先）。无效文件只告警，绝不让启动失败。
        var homeDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var skills = SkillRepository.Load(
            [
                SkillLocations.UserAgentsSkillsDirectory(homeDir),
                diHome.SkillsDirectory,
                .. SkillLocations.AncestorAgentsSkillDirectories(workspace),
                Path.Combine(DiHome.ProjectDirectory(workspace), "skills"),
            ],
            warn: msg => stderr.WriteLine($"⚠ {msg}"));

        // 默认提示词 = 内置工具说明 + 简洁助手人格；配置里显式写了 AgentLoop:SystemPrompt 则整体覆盖。
        var systemPrompt = string.IsNullOrWhiteSpace(agentLoop.SystemPrompt)
            ? CoreTools.BuildInstructions(workspace) + "\n\n" +
              "你是一个简洁的 ReAct 助手。需要事实信息时调用工具，不要编造。回答用中文。"
            : agentLoop.SystemPrompt;

        // --provider 覆盖配置的 provider 路由（模型工厂按它选适配器）。
        var effectiveProvider = !string.IsNullOrWhiteSpace(args.Provider) ? args.Provider : modelOptions.Provider;
        var retry = provider.GetRequiredService<IOptions<RetryPolicyOptions>>().Value;
        Func<string, IChatModel> modelFactory = name =>
            new RetryingChatModel(new ChatModelClient(llm, effectiveProvider, name), retry);

        // 跨回合记忆的上下文 token 预算（roadmap §3 缺口 #4）：按模型目录的 context window 比例。
        // 目录解析在内存中（DeepSeek 为纯查询），失败 / 模型不在目录 → null → 退回轮数启发式。
        Func<string, int?> contextWindowProvider = name =>
        {
            try
            {
                return llm.ResolveModelAsync(effectiveProvider, name).GetAwaiter().GetResult()?.Context?.ContextWindow;
            }
            catch
            {
                return null;
            }
        };

        // L1 上下文压缩（阶段一，docs/context-compression.md §9）：组合根把执行器包一层
        // CompactingExecutor（执行后预算控制：白名单工具大输出落盘 artifacts + 摘要进上下文）。
        // 控制开关 = 配置段 ContextManagement（分层配置，docs/di-home.md §3.1）；默认模型的窗口
        // 解析失败（模型不在目录 / provider 异常）→ 不包装，回退压缩前行为（headless 同路径）。
        var defaultModelName = args.Model ?? modelOptions.DefaultModel;
        IToolExecutor toolExecutor = executor;
        var contextOptions = provider.GetRequiredService<IOptions<ContextManagementOptions>>().Value;
        if (contextOptions.Enabled && ResolveContextWindow(llm, effectiveProvider, defaultModelName) is { } window && window > 0)
        {
            var policy = new BudgetPolicy(
                window,
                marginRatio: contextOptions.MarginRatio,
                outputReserveTokens: contextOptions.OutputReserveTokens,
                nextOutputReserveTokens: contextOptions.NextOutputReserveTokens,
                softRatio: contextOptions.SoftRatio,
                hardRatio: contextOptions.HardRatio,
                blockingRatio: contextOptions.BlockingRatio);
            toolExecutor = new CompactingExecutor(toolExecutor, policy, new ArtifactStore(diHome.RootDirectory));
        }

        // 推理强度启动时固定（--thinking 覆盖配置），快照挂到宿主供前端展示；运行期切换预留。
        var loopOptions = new AgentLoopOptions
        {
            SystemPrompt = systemPrompt,
            MaxIterations = agentLoop.MaxIterations,
            HistoryBudgetRatio = agentLoop.HistoryBudgetRatio,
            ReasoningEffort = !string.IsNullOrWhiteSpace(args.Thinking) ? args.Thinking : agentLoop.ReasoningEffort,
        };
        var runner = new AgentRunner(
            modelFactory,
            toolExecutor,
            loopOptions,
            provider.GetRequiredService<IEventBus>(),
            CoreTools.Definitions(workspace),
            workingDirectory: workspace,
            contextWindowProvider: contextWindowProvider,
            skills: skills)
        {
            // --model 覆盖配置默认模型（启动后交互模式仍可 /model 切换）。
            CurrentModel = defaultModelName,
        };

        var sessionLog = new SessionLog(new SessionLogOptions { RootDirectory = diHome.RootDirectory });

        // 运行日志（jcode 格式，~/.di/logs/di-YYYY-MM-DD.log）：事件总线旁路订阅回合生命周期事件。
        // DiLog 内部静默兜底（IO 失败只丢行、绝不抛），这里无需 try/catch；跟随宿主 Dispose 写
        // di exiting 并关闭文件。--help/--version/--info/--stats 等短路径不建宿主，故不产生日志。
        var diLog = new DiLog(new DiLogOptions { RootDirectory = diHome.RootDirectory });
        diLog.Subscribe(provider.GetRequiredService<IEventBus>());
        diLog.Log(LogLevel.Info, $"di starting pid={Environment.ProcessId} version={CliInfo.Version} workspace={workspace}");

        // 工具进程级诊断（proc: start / running / timeout / exited）接运行日志：事件总线订阅不到
        // 工具内部，经 ProcessDiagnostics 静态钩子单向注入（默认 no-op）；与 DiLog 一样静默兜底。
        ProcessDiagnostics.Log = msg => diLog.Log(LogLevel.Info, msg);

        // 输出重定向（管道/文件）时不写 ANSI 控制序列，避免污染捕获输出（--no-ansi 同样禁用）。
        if (!useAnsi)
            replOptions.UseAnsi = false;

        // 命令系统（roadmap Phase D 命令注册表）：内置 + ~/.di/commands/*.md 用户命令。
        // 与 skills 同规则：无效/重名文件只告警，绝不让启动失败；REPL 与 RPC 共用这份注册表。
        var commands = BuiltinCommands.CreateRegistry();
        CommandLoader.LoadInto(commands, diHome.CommandsDirectory, warn: msg => stderr.WriteLine($"⚠ {msg}"));

        return new CliHost(
            runner,
            provider.GetRequiredService<IEventBus>(),
            llm,
            skills,
            replOptions,
            sessionLog,
            disposer: new CompositeDisposer(executor, provider, diLog),
            commands: commands,
            reasoningEffort: loopOptions.ReasoningEffort);
    }

    /// <summary>
    /// 解析某模型的上下文窗口（咨询性目录查询，DeepSeek 为纯内存查询）。
    /// 失败 / 模型不在目录 → null（组合根据此不包装执行器，回退压缩前行为）。
    /// </summary>
    private static int? ResolveContextWindow(ILlmService llm, string provider, string modelName)
    {
        try
        {
            return llm.ResolveModelAsync(provider, modelName).GetAwaiter().GetResult()?.Context?.ContextWindow;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>顺序释放多个资源（工具执行器 → DI 容器）。</summary>
    private sealed class CompositeDisposer : IDisposable
    {
        private readonly IDisposable[] _inner;
        public CompositeDisposer(params IDisposable[] inner) => _inner = inner;
        public void Dispose()
        {
            foreach (var disposable in _inner)
                disposable?.Dispose();
        }
    }
}
