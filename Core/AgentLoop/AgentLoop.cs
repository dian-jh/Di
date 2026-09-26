using Core.Llm;

namespace Core.AgentLoop;

/// <summary>
/// 无外部依赖的 agent 主循环：把一次用户请求驱动到结束。
///
/// <code>
/// trajectory = [user_request]
/// repeat:
///     context   = stable_prefix + trajectory
///     decision  = model(context)
///     trajectory.append(decision)
///     if decision has no tool call: return decision.answer
///     for call in decision.tool_calls:
///         validated_call = validator?.validate(call) ?? call
///         observation    = executor.execute(validated_call)
///         trajectory.append(observation)
/// </code>
///
/// 只依赖 <see cref="IChatModel"/> 与注入的工具执行；不认识任何具体模型/厂商/工具。
/// 配置（循环上限等）通过 <see cref="AgentLoopOptions"/> 注入，不在代码中写死。
/// 扩展缝：<see cref="IToolValidator"/>（校验）、<see cref="IToolExecutor"/>（执行）。
/// </summary>
public sealed class AgentLoop
{
    private readonly IChatModel _model;
    private readonly AgentLoopOptions _options;

    public AgentLoop(IChatModel model, AgentLoopOptions options)
    {
        _model = model ?? throw new ArgumentNullException(nameof(model));
        _options = options ?? throw new ArgumentNullException(nameof(options));
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

            var response = await _model.CompleteAsync(new ModelRequest
            {
                Messages = BuildContext(trajectory),
                Tools = request.Tools,
                ReasoningEffort = _options.ReasoningEffort,
                MaxTokens = _options.MaxTokens,
            }, cancellationToken);

            usage = usage.Add(response.Usage);
            trajectory.Add(response.Message);   // decision

            var toolCalls = response.Message.ToolCalls;
            if (toolCalls.Count == 0)
            {
                return new AgentResult
                {
                    Answer = ChatMessageExtensions.GetText(response.Message),
                    Trajectory = trajectory,
                    Usage = usage,
                    Iterations = iterations,
                    StopReason = AgentStopReason.Answer,
                };
            }

            foreach (var call in toolCalls)
            {
                var validated = request.Validator?.Validate(call) ?? call;
                var observation = await ExecuteToolAsync(request.ToolExecutor, validated, cancellationToken);
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

    /// <summary>工具失败是观察结果，不是崩溃：模型可以据此继续。</summary>
    private static async Task<string> ExecuteToolAsync(IToolExecutor executor, ToolCallBlock call, CancellationToken cancellationToken)
    {
        try
        {
            return await executor.ExecuteAsync(call, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return $$"""{"error":"工具执行失败: {{ex.Message}}"}""";
        }
    }

    /// <summary>轨迹中最后一个 assistant 消息的可见文本（未收敛时可能是部分文本或空）。</summary>
    private static string LastAssistantText(IReadOnlyList<ChatMessage> trajectory) =>
        trajectory.OfType<AssistantMessage>()
            .Select(ChatMessageExtensions.GetText)
            .LastOrDefault() ?? string.Empty;
}
