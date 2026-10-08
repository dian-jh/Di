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

    public AgentRunner(
        Func<string, IChatModel> modelFactory,
        IToolExecutor toolExecutor,
        AgentLoopOptions options,
        IEventBus eventBus,
        IReadOnlyList<ChatTool>? tools = null)
    {
        _modelFactory = modelFactory ?? throw new ArgumentNullException(nameof(modelFactory));
        _toolExecutor = toolExecutor ?? throw new ArgumentNullException(nameof(toolExecutor));
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _eventBus = eventBus ?? throw new ArgumentNullException(nameof(eventBus));
        _tools = tools ?? [];
    }

    public string CurrentModel { get; set; } = "deepseek-flash";

    public Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default)
    {
        var model = _modelFactory(CurrentModel);
        var react = new ReAct(model, _options, _eventBus);
        return react.RunStreamingAsync(new AgentRequest
        {
            UserMessage = userMessage,
            Tools = _tools,
            ToolExecutor = _toolExecutor,
        }, cancellationToken);
    }
}
