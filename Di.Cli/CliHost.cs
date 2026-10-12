using Common.Events;
using Core.AgentLoop;
using Core.Configuration;
using Core.Llm;
using Core.Sessions;
using Core.Skills;
using Core.Tools;
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

    /// <summary>会话持久化（headless 单发也写日志；--no-session 时跳过）。</summary>
    public SessionLog? SessionLog { get; }

    public CliHost(IAgentRunner runner, IEventBus bus, ILlmService llm, IReadOnlyList<Skill> skills,
        ReplOptions replOptions, SessionLog? sessionLog = null, IDisposable? disposer = null)
    {
        Runner = runner ?? throw new ArgumentNullException(nameof(runner));
        Bus = bus ?? throw new ArgumentNullException(nameof(bus));
        Llm = llm ?? throw new ArgumentNullException(nameof(llm));
        Skills = skills ?? throw new ArgumentNullException(nameof(skills));
        ReplOptions = replOptions ?? throw new ArgumentNullException(nameof(replOptions));
        SessionLog = sessionLog;
        _disposer = disposer;
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

        var runner = new AgentRunner(
            modelFactory,
            executor,
            new AgentLoopOptions
            {
                SystemPrompt = systemPrompt,
                MaxIterations = agentLoop.MaxIterations,
                ReasoningEffort = !string.IsNullOrWhiteSpace(args.Thinking) ? args.Thinking : agentLoop.ReasoningEffort,
            },
            provider.GetRequiredService<IEventBus>(),
            CoreTools.Definitions(workspace),
            workingDirectory: workspace,
            skills: skills)
        {
            // --model 覆盖配置默认模型（启动后交互模式仍可 /model 切换）。
            CurrentModel = args.Model ?? modelOptions.DefaultModel,
        };

        var sessionLog = new SessionLog(new SessionLogOptions { RootDirectory = diHome.RootDirectory });

        // 输出重定向（管道/文件）时不写 ANSI 控制序列，避免污染捕获输出（--no-ansi 同样禁用）。
        if (!useAnsi)
            replOptions.UseAnsi = false;

        return new CliHost(
            runner,
            provider.GetRequiredService<IEventBus>(),
            llm,
            skills,
            replOptions,
            sessionLog,
            disposer: new CompositeDisposer(executor, provider));
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
