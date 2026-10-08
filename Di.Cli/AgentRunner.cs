using Common.Events;
using Core.AgentLoop;
using Core.Llm;

namespace Di.Cli;

/// <summary>
/// <see cref="IAgentRunner"/> 的标准实现：按当前模型名经工厂解析 <see cref="IChatModel"/>，
/// 把用户输入组装成 <see cref="AgentRequest"/> 交给 <see cref="ReAct"/> 执行。
/// 走流式路径：模型文本增量以 <see cref="AgentLoopEvent.TextDelta"/> 事件实时发布到
/// 共享 <see cref="IEventBus"/>，UI 从同一总线消费渲染。
/// </summary>
public sealed class AgentRunner : IAgentRunner
{
    private readonly Func<string, IChatModel> _modelFactory;
    private readonly AgentLoopOptions _options;
    private readonly IEventBus _eventBus;
    private readonly IReadOnlyList<ChatTool> _tools;
    private readonly IToolExecutor _toolExecutor;
    private readonly string? _workingDirectory;

    public AgentRunner(
        Func<string, IChatModel> modelFactory,
        IToolExecutor toolExecutor,
        AgentLoopOptions options,
        IEventBus eventBus,
        IReadOnlyList<ChatTool>? tools = null,
        string? workingDirectory = null)
    {
        _modelFactory = modelFactory ?? throw new ArgumentNullException(nameof(modelFactory));
        _toolExecutor = toolExecutor ?? throw new ArgumentNullException(nameof(toolExecutor));
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _eventBus = eventBus ?? throw new ArgumentNullException(nameof(eventBus));
        _tools = tools ?? [];
        _workingDirectory = workingDirectory;
    }

    public string CurrentModel { get; set; } = "deepseek-flash";

    public async Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default)
    {
        var model = _modelFactory(CurrentModel);
        var react = new ReAct(model, _options, _eventBus);

        // 环境感知快照：每个回合开始时刷新（git 状态在回合之间会变），注入为追加系统上下文。
        // 尽力而为——git 缺失/出错只导致快照退化为"仅工作目录"，绝不阻塞回合。
        string? systemContext = null;
        if (!string.IsNullOrWhiteSpace(_workingDirectory))
        {
            systemContext = await EnvironmentSnapshot.CaptureAsync(_workingDirectory, cancellationToken: cancellationToken)
                .ConfigureAwait(false);
        }

        return await react.RunStreamingAsync(new AgentRequest
        {
            UserMessage = userMessage,
            Tools = _tools,
            ToolExecutor = _toolExecutor,
            SystemContext = systemContext,
        }, cancellationToken).ConfigureAwait(false);
    }
}
