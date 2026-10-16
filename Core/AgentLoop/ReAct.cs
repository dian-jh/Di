using Common.Events;
using Core.Llm;

namespace Core.AgentLoop;

/// <summary>
/// 无外部依赖的 ReAct 主循环：把一次用户请求驱动到结束。
///
/// <code>
/// trajectory = [user_request]
/// repeat:
///     context   = stable_prefix + trajectory
///     decision  = model(context)
///     trajectory.append(decision)
///     if decision has no tool call: return decision.answer
///     if decision calls the final-output tool: return its arguments
///     if iteration budget is exhausted: stop (MaxIterations)
///     for call in decision.tool_calls:
///         validated_call = validator?.validate(call) ?? call
///         observation    = executor.execute(validated_call)
///         trajectory.append(observation)
/// </code>
///
/// 只依赖 <see cref="IChatModel"/> 与注入的工具执行；不认识任何具体模型/厂商/工具。
/// 配置（循环上限、最终输出工具等）通过 <see cref="AgentLoopOptions"/> 注入，不在代码中写死。
///
/// 扩展缝：
/// <list type="bullet">
/// <item><see cref="IToolValidator"/> —— 执行前校验（安全/权限挂点）。</item>
/// <item><see cref="IToolExecutor"/> —— 工具如何执行。</item>
/// <item><see cref="IEventBus"/> —— 运行过程事件经事件总线派发（日志/遥测/UI 挂点，可空则不发）。
///     发布是旁路的：不阻塞循环、单个坏订阅者不拖垮 loop（总线负责异常隔离）。</item>
/// <item><see cref="IInterruptSignal"/> —— 软停止：循环在两个相位边界（进入模型相位前 / 执行工具前）
///     轮询它，请求后以 <see cref="AgentStopReason.Interrupted"/> 优雅收敛。可空 = 不可软中断。
///     与硬取消（<see cref="RunAsync"/> 的 CancellationToken）正交。</item>
/// </list>
///
/// 故障语义：
/// <list type="bullet">
/// <item>工具执行失败 = 观察结果（模型可据此纠正），不是崩溃。</item>
/// <item>模型调用抛出的不可重试 <see cref="LlmException"/> → 以 <see cref="AgentStopReason.Error"/> 干净结束。</item>
/// <item>可重试异常（限流/超时等）向上传播，交给调用方 / 未来的重试策略。</item>
/// </list>
///
/// 设计文档见 docs/modules/agent-loop.md。
/// </summary>
public sealed class ReAct
{
    private readonly IChatModel _model;
    private readonly AgentLoopOptions _options;
    private readonly IEventBus? _eventBus;
    private readonly IInterruptSignal? _interrupt;

    public ReAct(IChatModel model, AgentLoopOptions options, IEventBus? eventBus = null,
        IInterruptSignal? interrupt = null)
    {
        _model = model ?? throw new ArgumentNullException(nameof(model));
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _eventBus = eventBus;
        _interrupt = interrupt;
    }

    public Task<AgentResult> RunAsync(AgentRequest request, CancellationToken cancellationToken = default)
        => RunCoreAsync(request, stream: false, cancellationToken);

    /// <summary>流式变体：模型输出逐段发布 <see cref="AgentLoopEvent.TextDelta"/> 事件，UI 可实时渲染。</summary>
    public Task<AgentResult> RunStreamingAsync(AgentRequest request, CancellationToken cancellationToken = default)
        => RunCoreAsync(request, stream: true, cancellationToken);

    private async Task<AgentResult> RunCoreAsync(AgentRequest request, bool stream, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        // trajectory = [history..., user_request] —— 跨回合记忆在 host 侧累加，ReAct 只负责拼装。
        var trajectory = new List<ChatMessage>();
        if (request.History is { Count: > 0 })
            trajectory.AddRange(request.History);
        trajectory.Add(ChatMessage.User(request.UserMessage));

        var usage = TokenUsage.Zero;
        var cost = (UsageCost?)null;
        var iterations = 0;
        var maxIterations = Math.Max(1, _options.MaxIterations);

        while (iterations < maxIterations)
        {
            // 相位边界 B0/B2：进入模型相位<b>之前</b>检查软停止。未开始的工作不启动——
            // 已完成的工具结果照常保留在轨迹里，本回合以 Interrupted 优雅收敛。
            if (_interrupt?.IsStopRequested == true)
                return StopInterrupted(trajectory, usage, cost, iterations, request.History);

            iterations++;

            // 模型调用发起（日志时间线的"发起"点）：在同一模型 await 前发布，
            // 返回时由 TurnCompleted 事件承载（日志侧据此算 duration_ms）。
            Emit(new ModelCallStarted(iterations));

            ModelResponse response;
            try
            {
                var modelRequest = new ModelRequest
                {
                    SessionId = request.SessionId,
                    Messages = BuildContext(request, trajectory),
                    Tools = request.Tools,
                    ReasoningEffort = _options.ReasoningEffort,
                    MaxTokens = _options.MaxTokens,
                };
                response = stream
                    ? await StreamModelAsync(modelRequest, cancellationToken)
                    : await _model.CompleteAsync(modelRequest, cancellationToken);
            }
            catch (LlmException ex) when (!ex.IsRetryable)
            {
                var result = Fail(trajectory, usage, cost, iterations, ex, request.History);
                Emit(new AgentLoopEvent.RunFailed(result.Failure!));
                return result;
            }

            usage = usage.Add(response.Usage);
            cost = CombineCost(cost, response.Cost);
            trajectory.Add(response.Message);   // decision
            Emit(new AgentLoopEvent.TurnCompleted(iterations, usage, cost, response.FinishReason));

            var toolCalls = response.Message.ToolCalls;
            if (toolCalls.Count == 0)
            {
                return new AgentResult
                {
                    Answer = LastAssistantText(trajectory),
                    Trajectory = trajectory,
                    History = request.History,
                    Usage = usage,
                    Cost = cost,
                    Iterations = iterations,
                    StopReason = AgentStopReason.Answer,
                };
            }

            // 相位边界 B1：模型刚产出（可能是文本 + 工具调用），工具相位尚未开始。
            // 软停止则不执行任何工具 —— 模型的可见文本已随流式事件到达 UI，这里原样保留为答案。
            // 注意：轨迹尾部是"未被响应的 tool_calls"，宿主的 SanitizeHistory 会按良构规则处理它。
            if (_interrupt?.IsStopRequested == true)
                return StopInterrupted(trajectory, usage, cost, iterations, request.History);

            foreach (var call in toolCalls)
            {
                // 最终输出工具：模型显式声明任务完成，参数即答案。
                if (_options.FinalOutputTool is { } final && call.Name == final)
                {
                    return new AgentResult
                    {
                        Answer = call.Arguments,
                        Trajectory = trajectory,
                        History = request.History,
                        Usage = usage,
                        Cost = cost,
                        Iterations = iterations,
                        StopReason = AgentStopReason.FinalOutputTool,
                    };
                }

                // 预算已耗尽：常规工具不再执行（其结果不会被下一次模型调用消费）。
                if (iterations >= maxIterations)
                    break;

                var validated = request.Validator?.Validate(call) ?? call;
                request.BeforeToolExecution?.Invoke(trajectory);
                Emit(new AgentLoopEvent.ToolStarted(call));
                var (observation, isError) = await ExecuteToolAsync(request.ToolExecutor, validated, cancellationToken);
                Emit(new AgentLoopEvent.ToolCompleted(call, observation, isError));
                trajectory.Add(ChatMessage.Tool(call.Id, observation));
            }
        }

        return new AgentResult
        {
            Answer = LastAssistantText(trajectory),
            Trajectory = trajectory,
            History = request.History,
            Usage = usage,
            Cost = cost,
            Iterations = iterations,
            StopReason = AgentStopReason.MaxIterations,
        };
    }

    /// <summary>
    /// 流式调用模型：消费事件流，把每个文本增量发布为 <see cref="AgentLoopEvent.TextDelta"/>，
    /// 最终取 <see cref="ModelEvent.Completed"/> 携带的完整响应（工具调用等已由模型层装配好）。
    /// </summary>
    private async Task<ModelResponse> StreamModelAsync(ModelRequest request, CancellationToken cancellationToken)
    {
        ModelResponse? response = null;
        await foreach (var evt in _model.StreamAsync(request, cancellationToken).ConfigureAwait(false))
        {
            switch (evt)
            {
                case ModelEvent.TextDelta { Text: var text }:
                    Emit(new AgentLoopEvent.TextDelta(text));
                    break;
                case ModelEvent.ReasoningDelta { Text: var reasoning }:
                    // M1：推理增量不再丢弃，转发给 UI（TUI 展示思考）。
                    Emit(new AgentLoopEvent.ReasoningDelta(reasoning));
                    break;
                case ModelEvent.ToolCallDelta { Id: var id, Name: var name, Arguments: var args }:
                    // M1：工具参数碎片以"迄今累计值"转发，UI 可实时展示（可能未完成）。
                    Emit(new AgentLoopEvent.ToolCallDelta(id, name, args));
                    break;
                case ModelEvent.Completed completed:
                    response = completed.Response;
                    break;
            }
        }

        return response
            ?? throw new LlmException("模型流在结束前中断，未收到 Completed。", LlmErrorCodes.BadResponse);
    }

    /// <summary>
    /// 布局：稳定 system prompt + 完整轨迹 + 易变 skills 上下文，保留稳定的缓存前缀。
    /// 最小环境快照属于持久轨迹；工具定义经 <see cref="ModelRequest.Tools"/> 传递。
    /// </summary>
    private IReadOnlyList<ChatMessage> BuildContext(AgentRequest request, IReadOnlyList<ChatMessage> trajectory)
    {
        var context = new List<ChatMessage>(trajectory.Count + 2);
        if (!string.IsNullOrWhiteSpace(_options.SystemPrompt))
            context.Add(ChatMessage.System(_options.SystemPrompt));
        context.AddRange(trajectory);
        if (!string.IsNullOrWhiteSpace(request.SystemContext))
            context.Add(ChatMessage.System(request.SystemContext));
        return context;
    }

    /// <summary>
    /// 工具失败是观察结果，不是崩溃：模型可以据此继续。
    /// 返回 (观察, 是否错误)。错误观察是纯文本，不假定 JSON。
    /// </summary>
    private static async Task<(string Observation, bool IsError)> ExecuteToolAsync(
        IToolExecutor executor, ToolCallBlock call, CancellationToken cancellationToken)
    {
        try
        {
            return (await executor.ExecuteAsync(call, cancellationToken), IsError: false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return ($"error executing tool '{call.Name}': {ex.Message}", IsError: true);
        }
    }

    /// <summary>
    /// 相位边界处的软停止：以 <see cref="AgentStopReason.Interrupted"/> 正常收敛（<b>不是</b>异常），
    /// 保留部分答案（轨迹里最后一个 assistant 文本）、完整轨迹与已发生的 usage/cost。
    /// 同时发布 <see cref="AgentLoopEvent.Interrupted"/> 供 UI 提示。
    /// </summary>
    private AgentResult StopInterrupted(IReadOnlyList<ChatMessage> trajectory, TokenUsage usage, UsageCost? cost,
        int iterations, IReadOnlyList<ChatMessage>? history)
    {
        Emit(new AgentLoopEvent.Interrupted());
        return new AgentResult
        {
            Answer = LastAssistantText(trajectory),
            Trajectory = trajectory,
            History = history,
            Usage = usage,
            Cost = cost,
            Iterations = iterations,
            StopReason = AgentStopReason.Interrupted,
        };
    }

    /// <summary>不可重试的模型故障：以干净的 <see cref="AgentStopReason.Error"/> 结果结束，而不是抛异常。</summary>
    private static AgentResult Fail(IReadOnlyList<ChatMessage> trajectory, TokenUsage usage, UsageCost? cost, int iterations, LlmException ex,
        IReadOnlyList<ChatMessage>? history) => new()
    {
        Answer = string.Empty,
        Trajectory = trajectory,
        History = history,
        Usage = usage,
        Cost = cost,   // 失败回合之前的已发生成本照常上报
        Iterations = iterations,
        StopReason = AgentStopReason.Error,
        Failure = new LlmFailure(ex.Message, ex.Code, ex.Status, ex.ProviderRetryAfter),
    };

    /// <summary>累计成本：null 视为无成本，遇 null 保持原值（目录无费率/适配器未上报时不产生成本段）。</summary>
    private static UsageCost? CombineCost(UsageCost? acc, UsageCost? next) =>
        next is null ? acc : acc is null ? next : acc.Add(next);

    /// <summary>轨迹中最后一个 assistant 消息的可见文本。</summary>
    private static string LastAssistantText(IReadOnlyList<ChatMessage> trajectory) =>
        trajectory.OfType<AssistantMessage>()
            .Select(ChatMessageExtensions.GetText)
            .LastOrDefault() ?? string.Empty;

    /// <summary>发布观察事件到总线（旁路、fire-and-forget；不阻塞循环，也不等待订阅者完成）。
    /// 泛型保留调用点的<b>具体静态类型</b>——总线沿继承链向上派发以静态类型为天花板，
    /// 若收窄为 <see cref="IEvent"/>，AgentLoopEvent 订阅者将收不到任何事件。故除 AgentLoopEvent
    /// 家族外，这里也能发布日志生命周期事件（<see cref="ModelCallStarted"/>，见 RunEvents.cs）。</summary>
    private void Emit<TEvent>(TEvent evt) where TEvent : IEvent => _ = _eventBus?.PublishAsync(evt);
}
