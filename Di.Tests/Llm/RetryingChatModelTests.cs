using System.Runtime.CompilerServices;
using Core.Llm;

namespace Di.Tests.Llm;

/// <summary>
/// 针对 <see cref="RetryingChatModel"/>（API 限流/超时重试退避）的单元测试。
/// 注入假 sleeper 让测试确定、快速；只关心"重试了几次、等多久、最终结果"。
/// </summary>
public sealed class RetryingChatModelTests
{
    private static ModelResponse Ok() => new()
    {
        Message = ChatMessage.Assistant("ok"),
        FinishReason = new FinishReason.Stop(),
        Usage = TokenUsage.Zero,
    };

    private static LlmException RateLimited(TimeSpan? retryAfter = null) =>
        new("rate limited", LlmErrorCodes.RateLimited, status: 429, providerRetryAfter: retryAfter);

    private static ModelRequest Request() => new() { Messages = [ChatMessage.User("hi")] };

    [Fact]
    public async Task CompleteAsync_RetryableThenSuccess_RetriesAndReturns()
    {
        var calls = 0;
        var inner = new FakeChatModel(() =>
        {
            calls++;
            return calls == 1 ? throw RateLimited() : Ok();
        });
        var sleep = new RecordingSleeper();
        var model = new RetryingChatModel(inner, new RetryPolicyOptions { MaxAttempts = 3, InitialBackoff = TimeSpan.Zero },
            sleep.Sleep);

        var response = await model.CompleteAsync(Request());

        Assert.Equal(2, calls);
        Assert.Equal("ok", response.Message.GetText());
        Assert.Single(sleep.Delays);
    }

    [Fact]
    public async Task CompleteAsync_NonRetryable_ThrowsImmediately()
    {
        var calls = 0;
        var inner = new FakeChatModel(() =>
        {
            calls++;
            throw new LlmException("bad", LlmErrorCodes.InvalidRequest, status: 400);
        });
        var model = new RetryingChatModel(inner, new RetryPolicyOptions { MaxAttempts = 3 });

        await Assert.ThrowsAsync<LlmException>(() => model.CompleteAsync(Request()));

        Assert.Equal(1, calls);   // 非可重试（400）不重试
    }

    [Fact]
    public async Task CompleteAsync_ExhaustsRetries_RethrowsLastError()
    {
        var calls = 0;
        var inner = new FakeChatModel(() =>
        {
            calls++;
            throw RateLimited();
        });
        var model = new RetryingChatModel(inner, new RetryPolicyOptions { MaxAttempts = 3, InitialBackoff = TimeSpan.Zero });

        await Assert.ThrowsAsync<LlmException>(() => model.CompleteAsync(Request()));

        Assert.Equal(3, calls);   // 首次 + 2 次重试，耗尽后抛出
    }

    [Fact]
    public async Task CompleteAsync_RespectsProviderRetryAfter()
    {
        var calls = 0;
        var inner = new FakeChatModel(() =>
        {
            calls++;
            return calls == 1 ? throw RateLimited(retryAfter: TimeSpan.FromSeconds(2)) : Ok();
        });
        var sleep = new RecordingSleeper();
        var model = new RetryingChatModel(inner, new RetryPolicyOptions { MaxAttempts = 3 }, sleep.Sleep);

        await model.CompleteAsync(Request());

        var delay = Assert.Single(sleep.Delays);
        Assert.True(delay >= TimeSpan.FromSeconds(1.6) && delay <= TimeSpan.FromSeconds(2.4),
            $"应尊重 retry-after≈2s（抖动 ±20%），实际 {delay}");
    }

    [Fact]
    public async Task CompleteAsync_BackoffGrowsExponentially()
    {
        var calls = 0;
        var inner = new FakeChatModel(() =>
        {
            calls++;
            return calls < 4 ? throw RateLimited() : Ok();
        });
        var sleep = new RecordingSleeper();
        var model = new RetryingChatModel(inner,
            new RetryPolicyOptions { MaxAttempts = 4, InitialBackoff = TimeSpan.FromMilliseconds(100), BackoffMultiplier = 2 },
            sleep.Sleep);

        await model.CompleteAsync(Request());

        Assert.Equal(3, sleep.Delays.Count);
        Assert.True(sleep.Delays[0] >= TimeSpan.FromMilliseconds(80) && sleep.Delays[0] <= TimeSpan.FromMilliseconds(120), $"{sleep.Delays[0]}");
        Assert.True(sleep.Delays[1] >= TimeSpan.FromMilliseconds(160) && sleep.Delays[1] <= TimeSpan.FromMilliseconds(240), $"{sleep.Delays[1]}");
        Assert.True(sleep.Delays[2] >= TimeSpan.FromMilliseconds(320) && sleep.Delays[2] <= TimeSpan.FromMilliseconds(480), $"{sleep.Delays[2]}");
    }

    [Fact]
    public async Task StreamAsync_RetryableAtStart_RetriesAndYieldsFinalEvents()
    {
        var calls = 0;
        var inner = new FakeChatModel(() =>
        {
            calls++;
            return calls == 1 ? throw RateLimited() : Ok();
        });
        var model = new RetryingChatModel(inner, new RetryPolicyOptions { MaxAttempts = 3, InitialBackoff = TimeSpan.Zero });

        var events = new List<ModelEvent>();
        await foreach (var evt in model.StreamAsync(Request()))
            events.Add(evt);

        Assert.Equal(2, calls);   // 流在起点失败 → 整体重试
        var completed = Assert.Single(events.OfType<ModelEvent.Completed>());
        Assert.Equal("ok", completed.Response.Message.GetText());
    }

    [Fact]
    public async Task StreamAsync_NonRetryable_PropagatesWithoutRetry()
    {
        var calls = 0;
        var inner = new FakeChatModel(() =>
        {
            calls++;
            throw new LlmException("bad", LlmErrorCodes.InvalidRequest, status: 400);
        });
        var model = new RetryingChatModel(inner, new RetryPolicyOptions { MaxAttempts = 3 });

        await Assert.ThrowsAsync<LlmException>(async () =>
        {
            await foreach (var _ in model.StreamAsync(Request())) { }
        });

        Assert.Equal(1, calls);
    }

    private sealed class FakeChatModel : IChatModel
    {
        private readonly Func<ModelResponse> _call;

        public FakeChatModel(Func<ModelResponse> call) => _call = call;

        public Task<ModelResponse> CompleteAsync(ModelRequest request, CancellationToken cancellationToken = default)
            => Task.FromResult(_call());

        public async IAsyncEnumerable<ModelEvent> StreamAsync(
            ModelRequest request, [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            yield return new ModelEvent.Completed(_call());
        }
    }

    private sealed class RecordingSleeper
    {
        public List<TimeSpan> Delays { get; } = [];

        public Task Sleep(TimeSpan delay, CancellationToken cancellationToken = default)
        {
            Delays.Add(delay);
            return Task.CompletedTask;
        }
    }
}
