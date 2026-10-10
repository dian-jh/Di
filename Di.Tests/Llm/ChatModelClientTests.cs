using Core.Llm;

namespace Di.Tests.Llm;

/// <summary>
/// <see cref="ChatModelClient"/> 的流协议纪律与元数据（P1-④/⑥ + 成本挂载）：
/// Finish 之后不得再有任何事件（防坏适配器）；ResponseInfo / 时间戳 / 耗时 / 成本
/// 组装进 <see cref="ModelResponse"/>；请求的采样参数完整透传到 <see cref="GenerateOptions"/>。
/// </summary>
public sealed class ChatModelClientTests
{
    private static ModelRequest Request() => new() { Messages = [ChatMessage.User("hi")] };

    private static ModelResponse CompletedResponse(List<ModelEvent> events) =>
        Assert.Single(events.OfType<ModelEvent.Completed>()).Response;

    [Fact]
    public async Task StreamAsync_StopsAfterFinish_IgnoresTrailingChunks()
    {
        var llm = new FakeLlmService
        {
            Chunks =
            [
                new StreamChunk.TextDelta(0, "hello"),
                new StreamChunk.Finish(new FinishReason.Stop()),
                new StreamChunk.TextDelta(0, "TRAILING"),   // 坏适配器在 Finish 后又发内容
            ],
        };
        var model = new ChatModelClient(llm, "p", "m");

        var events = new List<ModelEvent>();
        await foreach (var evt in model.StreamAsync(Request()))
            events.Add(evt);

        // Finish 之后的增量不得作为事件流出；Completed 仍正常发出。
        Assert.DoesNotContain(events, e => e is ModelEvent.TextDelta { Text: "TRAILING" });
        Assert.Single(events.OfType<ModelEvent.TextDelta>());
        Assert.Equal("hello", CompletedResponse(events).Message.GetText());
    }

    [Fact]
    public async Task StreamAsync_CapturesResponseId()
    {
        var llm = new FakeLlmService
        {
            Chunks =
            [
                new StreamChunk.ResponseInfo("resp-928374"),
                new StreamChunk.Finish(new FinishReason.Stop()),
            ],
        };
        var model = new ChatModelClient(llm, "p", "m");

        var events = new List<ModelEvent>();
        await foreach (var evt in model.StreamAsync(Request()))
            events.Add(evt);

        Assert.Equal("resp-928374", CompletedResponse(events).ResponseId);
    }

    [Fact]
    public async Task StreamAsync_ComputesCost_FromService()
    {
        var llm = new FakeLlmService
        {
            Chunks =
            [
                new StreamChunk.Usage(new TokenUsage(1_000_000, 1_000_000)),
                new StreamChunk.Finish(new FinishReason.Stop()),
            ],
            CostResult = new UsageCost(1.0, 2.0, 0, 0),
        };
        var model = new ChatModelClient(llm, "p", "m");

        var events = new List<ModelEvent>();
        await foreach (var evt in model.StreamAsync(Request()))
            events.Add(evt);

        var response = CompletedResponse(events);
        Assert.Equal(new UsageCost(1.0, 2.0, 0, 0), response.Cost);
        Assert.Equal(1_000_000, response.Usage.InputTokens);
    }

    [Fact]
    public async Task StreamAsync_SetsTimestampAndDuration()
    {
        var llm = new FakeLlmService { Chunks = [new StreamChunk.Finish(new FinishReason.Stop())] };
        var model = new ChatModelClient(llm, "p", "m");

        var events = new List<ModelEvent>();
        await foreach (var evt in model.StreamAsync(Request()))
            events.Add(evt);

        var response = CompletedResponse(events);
        Assert.True(response.Timestamp > 0, "Timestamp 应是请求开始时刻的 Unix 毫秒");
        Assert.NotNull(response.DurationMs);
        Assert.True(response.DurationMs >= 0);
    }

    [Fact]
    public async Task StreamAsync_MapsSamplingParams_FromRequest()
    {
        var llm = new FakeLlmService { Chunks = [new StreamChunk.Finish(new FinishReason.Stop())] };
        var model = new ChatModelClient(llm, "p", "m");

        var request = Request() with
        {
            TopP = 0.8,
            FrequencyPenalty = 0.5,
            PresencePenalty = -0.2,
            Temperature = 0.7,
            MaxTokens = 2048,
        };
        await foreach (var _ in model.StreamAsync(request)) { }

        var options = llm.LastOptions!;
        Assert.Equal(0.8, options.TopP);
        Assert.Equal(0.5, options.FrequencyPenalty);
        Assert.Equal(-0.2, options.PresencePenalty);
        Assert.Equal(0.7, options.Temperature);
        Assert.Equal(2048, options.MaxTokens);
    }

    [Fact]
    public async Task StreamAsync_UnsetSamplingParams_StayNull()
    {
        var llm = new FakeLlmService { Chunks = [new StreamChunk.Finish(new FinishReason.Stop())] };
        var model = new ChatModelClient(llm, "p", "m");

        await foreach (var _ in model.StreamAsync(Request())) { }

        Assert.Null(llm.LastOptions!.TopP);
        Assert.Null(llm.LastOptions.FrequencyPenalty);
        Assert.Null(llm.LastOptions.PresencePenalty);
    }

    private sealed class FakeLlmService : ILlmService
    {
        public IReadOnlyList<StreamChunk>? Chunks { get; set; }
        public UsageCost? CostResult { get; set; }
        public GenerateOptions? LastOptions { get; private set; }

        public IAdapterRegistration RegisterAdapter(string[] providers, ChatAdapter adapter) => throw new NotSupportedException();

        public IReadOnlyList<LlmProviderInfo> ListProviders() => throw new NotSupportedException();

        public IReadOnlyList<LlmModelInfo> ListModels(string? provider = null) => throw new NotSupportedException();

        public UsageCost? CalculateCost(string provider, string model, TokenUsage usage) => CostResult;

        public Task<LlmResolvedModelInfo> ResolveModelAsync(
            string provider, string model, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public async IAsyncEnumerable<StreamChunk> StreamAsync(GenerateOptions options)
        {
            LastOptions = options;
            foreach (var chunk in Chunks ?? [])
                yield return chunk;
        }

        public Task<bool> CheckAuthAsync(string provider, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public event Action? AdaptersUpdated { add { } remove { } }
    }
}
