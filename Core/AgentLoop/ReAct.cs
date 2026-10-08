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
/// </list>
///
/// 故障语义：
/// <list type="bullet">
/// <item>工具执行失败 = 观察结果（模型可据此纠正），不是崩溃。</item>
/// <item>模型调用抛出的不可重试 <see cref="LlmException"/> → 以 <see cref="AgentStopReason.Error"/> 干净结束。</item>
/// <item>可重试异常（限流/超时等）向上传播，交给调用方 / 未来的重试策略。</item>
/// </list>
/// </summary>
public sealed class ReAct
{
    private readonly IChatModel _model;
    private readonly AgentLoopOptions _options;
    private readonly IEventBus? _eventBus;

    public ReAct(IChatModel model, AgentLoopOptions options, IEventBus? eventBus = null)
    {
        _model = model ?? throw new ArgumentNullException(nameof(model));
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _eventBus = eventBus;
    }

    public async Task<AgentResult> RunAsync(AgentRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);

        // trajectory = [user_request]
        var trajectory = new List<ChatMessage>
        {
            ChatMessage.User(request.UserMessage),
        };

        var usage = TokenUsage.Zero;
        var iterations = 0;
        var maxIterations = Math.Max(1, _options.MaxIterations);

        while (iterations < maxIterations)
        {
            iterations++;

            ModelResponse response;
            try
            {
                response = await _model.CompleteAsync(new ModelRequest
                {
                    Messages = BuildContext(trajectory),
                    Tools = request.Tools,
                    ReasoningEffort = _options.ReasoningEffort,
                    MaxTokens = _options.MaxTokens,
                }, cancellationToken);
            }
            catch (LlmException ex) when (!ex.IsRetryable)
            {
                var result = Fail(trajectory, usage, iterations, ex);
                Emit(new AgentLoopEvent.RunFailed(result.Failure!));
                return result;
            }

            usage = usage.Add(response.Usage);
            trajectory.Add(response.Message);   // decision
            Emit(new AgentLoopEvent.TurnCompleted(iterations, usage, response.FinishReason));

            var toolCalls = response.Message.ToolCalls;
            if (toolCalls.Count == 0)
            {
                return new AgentResult
                {
                    Answer = LastAssistantText(trajectory),
                    Trajectory = trajectory,
                    Usage = usage,
                    Iterations = iterations,
                    StopReason = AgentStopReason.Answer,
                };
            }

            foreach (var call in toolCalls)
            {
                // 最终输出工具：模型显式声明任务完成，参数即答案。
                if (_options.FinalOutputTool is { } final && call.Name == final)
                {
                    return new AgentResult
                    {
                        Answer = call.Arguments,
                        Trajectory = trajectory,
                        Usage = usage,
                        Iterations = iterations,
                        StopReason = AgentStopReason.FinalOutputTool,
                    };
                }

                // 预算已耗尽：常规工具不再执行（其结果不会被下一次模型调用消费）。
                if (iterations >= maxIterations)
                    break;

                var validated = request.Validator?.Validate(call) ?? call;
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
            Usage = usage,
            Iterations = iterations,
            StopReason = AgentStopReason.MaxIterations,
        };
    }

    /// <summary>稳定前缀 + 轨迹。工具定义经 <see cref="ModelRequest.Tools"/> 传递。</summary>
    private IReadOnlyList<ChatMessage> BuildContext(IReadOnlyList<ChatMessage> trajectory)
    {
        if (string.IsNullOrWhiteSpace(_options.SystemPrompt))
            return trajectory;

        var context = new List<ChatMessage>(trajectory.Count + 1)
        {
            ChatMessage.System(_options.SystemPrompt),
        };
        context.AddRange(trajectory);
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

    /// <summary>不可重试的模型故障：以干净的 <see cref="AgentStopReason.Error"/> 结果结束，而不是抛异常。</summary>
    private static AgentResult Fail(IReadOnlyList<ChatMessage> trajectory, TokenUsage usage, int iterations, LlmException ex) => new()
    {
        Answer = string.Empty,
        Trajectory = trajectory,
        Usage = usage,
        Iterations = iterations,
        StopReason = AgentStopReason.Error,
        Failure = new LlmFailure(ex.Message, ex.Code, ex.Status, ex.ProviderRetryAfter),
    };

    /// <summary>轨迹中最后一个 assistant 消息的可见文本。</summary>
    private static string LastAssistantText(IReadOnlyList<ChatMessage> trajectory) =>
        trajectory.OfType<AssistantMessage>()
            .Select(ChatMessageExtensions.GetText)
            .LastOrDefault() ?? string.Empty;

    /// <summary>发布观察事件到总线（旁路、fire-and-forget；不阻塞循环，也不等待订阅者完成）。</summary>
    private void Emit(AgentLoopEvent evt) => _ = _eventBus?.PublishAsync(evt);
}
