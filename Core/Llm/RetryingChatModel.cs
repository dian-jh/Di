using System.Runtime.CompilerServices;

namespace Core.Llm;

/// <summary>重试策略配置。</summary>
public sealed class RetryPolicyOptions
{
    /// <summary>总尝试次数（含首次）。达到后把最后一次异常抛给上层。</summary>
    public int MaxAttempts { get; init; } = 3;

    /// <summary>首次重试等待（无 retry-after 时按指数退避增长）。</summary>
    public TimeSpan InitialBackoff { get; init; } = TimeSpan.FromMilliseconds(500);

    /// <summary>退避上限（也用来给 retry-after 封顶，避免无界等待）。</summary>
    public TimeSpan MaxBackoff { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>指数退避的倍率。</summary>
    public double BackoffMultiplier { get; init; } = 2.0;
}

/// <summary>
/// <see cref="IChatModel"/> 装饰器：对可重试故障（限流 429 / 超时 / 连接 / 5xx）做指数退避重试。
///
/// 重试完全发生在模型层 —— ReAct / AgentRunner 看不到重试过程，只会看到：
/// 成功响应、不可重试异常（立即抛出）、或重试耗尽后的最后一个可重试异常。
/// 尊重提供方的 Retry-After 头（<see cref="LlmException.ProviderRetryAfter"/>），并加 ±20% 抖动
/// 避免同一批请求同时撞限流。
///
/// 流式重试：整体重新枚举。限流通常在请求起点就拒绝（首事件前抛错），此时重试是干净的；
/// 极少数流中段断开会重放已产出的事件——比整个回合死掉值得。
/// </summary>
public sealed class RetryingChatModel : IChatModel
{
    private readonly IChatModel _inner;
    private readonly RetryPolicyOptions _options;
    private readonly Func<TimeSpan, CancellationToken, Task> _sleep;

    public RetryingChatModel(IChatModel inner, RetryPolicyOptions? options = null, Func<TimeSpan, CancellationToken, Task>? sleep = null)
    {
        _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        _options = options ?? new RetryPolicyOptions();
        _sleep = sleep ?? Task.Delay;
    }

    public async Task<ModelResponse> CompleteAsync(ModelRequest request, CancellationToken cancellationToken = default)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await _inner.CompleteAsync(request, cancellationToken).ConfigureAwait(false);
            }
            catch (LlmException ex) when (ex.IsRetryable && attempt < _options.MaxAttempts)
            {
                await SleepAsync(ex, attempt, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    public async IAsyncEnumerable<ModelEvent> StreamAsync(
        ModelRequest request, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // 手动推进枚举器而非 await foreach：C# 不允许在带 catch 的 try 里 yield，
        // 而流式重试需要捕获枚举中途的可重试异常。
        for (var attempt = 1; ; attempt++)
        {
            await using var enumerator = _inner.StreamAsync(request, cancellationToken).GetAsyncEnumerator(cancellationToken);
            while (true)
            {
                ModelEvent evt;
                bool completed;
                try
                {
                    completed = await enumerator.MoveNextAsync().ConfigureAwait(false);
                    evt = completed ? enumerator.Current : null!;
                }
                catch (LlmException ex) when (ex.IsRetryable && attempt < _options.MaxAttempts)
                {
                    await SleepAsync(ex, attempt, cancellationToken).ConfigureAwait(false);
                    break;   // 放弃本次枚举（enumerator 随即被 dispose），外层 for 重试
                }
                if (!completed)
                    yield break;   // 流正常结束
                yield return evt;
            }
        }
    }

    private Task SleepAsync(LlmException ex, int attempt, CancellationToken cancellationToken)
    {
        // retry-after 优先；没有则指数退避：initial * multiplier^(attempt-1)。两者都封顶。
        var candidate = ex.ProviderRetryAfter
            ?? TimeSpan.FromMilliseconds(_options.InitialBackoff.TotalMilliseconds
                                         * Math.Pow(_options.BackoffMultiplier, attempt - 1));
        var delay = candidate > _options.MaxBackoff ? _options.MaxBackoff : candidate;
        // ±20% 抖动，避免重试风暴。
        delay = delay * (0.8 + Random.Shared.NextDouble() * 0.4);
        return _sleep(delay, cancellationToken);
    }
}
