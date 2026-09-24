using System.Runtime.CompilerServices;

namespace Core.Llm;

/// <summary>
/// <see cref="IChatModel"/> 的标准实现：包装 <see cref="ILlmService"/>。
/// 模型（provider+model）在构造时绑定，适配器的注册/路由由下层 <see cref="ILlmService"/> 负责。
/// </summary>
public sealed class ChatModelClient : IChatModel
{
    private readonly ILlmService _llm;
    private readonly string _provider;
    private readonly string _model;

    public ChatModelClient(ILlmService llm, string provider, string model)
    {
        _llm = llm ?? throw new ArgumentNullException(nameof(llm));
        ArgumentException.ThrowIfNullOrWhiteSpace(provider);
        ArgumentException.ThrowIfNullOrWhiteSpace(model);
        _provider = provider;
        _model = model;
    }

    public Task<ModelResponse> CompleteAsync(ModelRequest request, CancellationToken cancellationToken = default)
    {
        // 模拟 M.E.AI 的扩展式：Complete 是 Combine 的聚合（这里简单实现为消费流）。
        return StreamToResponseAsync(request, cancellationToken);
    }

    public async IAsyncEnumerable<ModelEvent> StreamAsync(
        ModelRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var options = new GenerateOptions
        {
            Provider = _provider,
            Model = _model,
            Messages = request.Messages,
            Tools = request.Tools,
            ReasoningEffort = request.ReasoningEffort,
            Temperature = request.Temperature,
            MaxTokens = request.MaxTokens,
            Stop = request.Stop,
            CancellationToken = cancellationToken,
        };

        var assembler = new ChatAssembler();
        var usage = TokenUsage.Zero;
        var finish = (FinishReason)new FinishReason.Stop();

        await foreach (var chunk in _llm.StreamAsync(options).ConfigureAwait(false))
        {
            assembler.Add(chunk);

            switch (chunk)
            {
                case StreamChunk.TextDelta text:
                    yield return new ModelEvent.TextDelta(text.Text);
                    break;

                case StreamChunk.ReasoningDelta reasoning:
                    yield return new ModelEvent.ReasoningDelta(reasoning.Text);
                    break;

                case StreamChunk.ToolCallDelta toolCall:
                    yield return new ModelEvent.ToolCallDelta(toolCall.Id, toolCall.Name ?? "", toolCall.ArgumentsDelta);
                    break;

                case StreamChunk.Usage usageChunk:
                    usage = usageChunk.Tokens;
                    yield return new ModelEvent.Usage(usage);
                    break;

                case StreamChunk.Finish finishChunk:
                    finish = finishChunk.Reason;
                    break;
            }
        }

        yield return new ModelEvent.Completed(new ModelResponse
        {
            Message = assembler.Build(),
            FinishReason = finish,
            Usage = usage,
            Model = _model,
        });
    }

    private async Task<ModelResponse> StreamToResponseAsync(ModelRequest request, CancellationToken cancellationToken)
    {
        ModelResponse? response = null;
        await foreach (var evt in StreamAsync(request, cancellationToken).ConfigureAwait(false))
        {
            if (evt is ModelEvent.Completed completed)
                response = completed.Response;
        }

        return response
            ?? throw new LlmException($"模型流在结束前中断，未收到 Completed。", LlmErrorCodes.BadResponse);
    }
}