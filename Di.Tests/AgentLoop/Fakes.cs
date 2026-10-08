using Common.Events;
using Core.AgentLoop;
using Core.Llm;

namespace Di.Tests;

/// <summary>
/// 测试替身：按队列依次返回预置响应；队列耗尽后回落到 fallback（若有）。
/// </summary>
internal sealed class FakeChatModel : IChatModel
{
    private readonly Queue<Func<ModelRequest, ModelResponse>> _responses = new();
    private Func<ModelRequest, ModelResponse>? _fallback;

    /// <summary>记录每次收到的请求，用于断言上下文内容。</summary>
    public List<ModelRequest> Requests { get; } = [];

    public void Enqueue(Func<ModelRequest, ModelResponse> factory) => _responses.Enqueue(factory);

    public void Fallback(Func<ModelRequest, ModelResponse> factory) => _fallback = factory;

    public Task<ModelResponse> CompleteAsync(ModelRequest request, CancellationToken cancellationToken = default)
    {
        Requests.Add(request);
        var factory = _responses.Count > 0 ? _responses.Dequeue() : _fallback
            ?? throw new InvalidOperationException("测试模型没有预置响应。");
        return Task.FromResult(factory(request));
    }

    public IAsyncEnumerable<ModelEvent> StreamAsync(ModelRequest request, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("循环测试走 CompleteAsync 路径。");
}

/// <summary>记录收到的工具调用，按 handler 返回观察结果。</summary>
internal sealed class FakeToolExecutor : IToolExecutor
{
    private readonly Func<ToolCallBlock, string> _handler;

    public List<ToolCallBlock> Calls { get; } = [];

    public FakeToolExecutor(Func<ToolCallBlock, string> handler) => _handler = handler;

    public Task<string> ExecuteAsync(ToolCallBlock call, CancellationToken cancellationToken = default)
    {
        Calls.Add(call);
        return Task.FromResult(_handler(call));
    }
}

/// <summary>放行并记录每次校验。</summary>
internal sealed class RecordingValidator : IToolValidator
{
    public List<ToolCallBlock> Calls { get; } = [];

    public ToolCallBlock Validate(ToolCallBlock call)
    {
        Calls.Add(call);
        return call;
    }
}

/// <summary>永远拒绝执行。</summary>
internal sealed class RejectingValidator : IToolValidator
{
    public ToolCallBlock Validate(ToolCallBlock call) => throw new InvalidOperationException("拒绝执行");
}

/// <summary>订阅事件总线并记录全部 AgentLoopEvent 的观察者。</summary>
internal sealed class RecordingObserver : IEventHandler<AgentLoopEvent>
{
    public List<AgentLoopEvent> Events { get; } = [];

    public Task HandleAsync(AgentLoopEvent evt, CancellationToken cancellationToken = default)
    {
        Events.Add(evt);
        return Task.CompletedTask;
    }
}
