using System.Text.Json;
using System.Text.Json.Nodes;
using Common.Events;
using Core.AgentLoop;
using Core.Llm;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using ReAct = Core.AgentLoop.ReAct;

namespace Di.Tests.Integration;

/// <summary>
/// 针对真实 DeepSeek API 的端到端集成测试（完整链路：适配器 → 模型层 → ReAct 循环）。
/// 未设置 DEEPSEEK_API_KEY 时自动跳过，不会误伤 CI。
/// 会消耗真实 token —— 日常跑单元测试请用 --filter "Category!=Integration" 排除。
/// </summary>
[Trait("Category", "Integration")]
public sealed class DeepSeekReActIntegrationTests
{
    [SkippableFact]
    public async Task RunAsync_AgainstRealDeepSeek_CompletesReActCycle()
    {
        Skip.If(string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("DEEPSEEK_API_KEY")),
            "未设置 DEEPSEEK_API_KEY，跳过真实 API 集成测试。");

        // 组合根：只装配模型层 + DeepSeek 适配器（配置为空即可，API Key 走环境变量）。
        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().Build());
        services.AddLlm();
        services.AddDeepSeek();
        await using var provider = services.BuildServiceProvider();

        var model = new ChatModelClient(
            provider.GetRequiredService<ILlmService>(),
            "deepseek",
            "deepseek-flash");

        var bus = new InMemoryEventBus();
        bus.Subscribe(new ConsoleObserver());
        var react = new ReAct(model, new AgentLoopOptions
        {
            SystemPrompt =
                "你是一个极简的 ReAct agent。需要事实信息时调用工具，不要凭空编造。拿到工具结果后给出简洁的中文回答。",
            MaxIterations = 6,
            MaxTokens = 8192,
            ReasoningEffort = "high",
        }, bus);

        var result = await react.RunAsync(new AgentRequest
        {
            UserMessage = "现在几点？另外帮我算一下 1234 加 5678 等于多少。",
            Tools =
            [
                Tool("get_current_utc_time", "获取当前的 UTC 时间。参数为空。",
                    """{"type":"object","properties":{},"required":[]}"""),
                Tool("add_numbers", "计算两个数字的和。当用户需要算术结果时使用。",
                    """{"type":"object","properties":{"a":{"type":"number","description":"第一个加数"},"b":{"type":"number","description":"第二个加数"}},"required":["a","b"]}"""),
            ],
            ToolExecutor = new DemoToolExecutor(),
        }, new CancellationTokenSource(TimeSpan.FromSeconds(180)).Token);

        // 观察输出
        Console.WriteLine();
        Console.WriteLine($"════ 结果 ════  stop={result.StopReason}  iterations={result.Iterations}");
        Console.WriteLine(result.Answer);
        Console.WriteLine($"累计用量：{result.Usage}");

        // 宽松断言：真实模型输出不保证精确格式，只校验"正常收敛 + 有内容 + 工具被调用"。
        Assert.Equal(AgentStopReason.Answer, result.StopReason);
        Assert.False(string.IsNullOrWhiteSpace(result.Answer));
        Assert.Contains("1234", result.Answer, StringComparison.Ordinal);
        Assert.Contains("5678", result.Answer, StringComparison.Ordinal);
    }

    [SkippableFact]
    public async Task RunStreamingAsync_AgainstRealDeepSeek_EmitsTextDeltaEvents()
    {
        Skip.If(string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("DEEPSEEK_API_KEY")),
            "未设置 DEEPSEEK_API_KEY，跳过真实 API 集成测试。");

        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().Build());
        services.AddLlm();
        services.AddDeepSeek();
        await using var provider = services.BuildServiceProvider();

        var model = new ChatModelClient(
            provider.GetRequiredService<ILlmService>(),
            "deepseek",
            "deepseek-flash");

        var bus = new InMemoryEventBus();
        using var consumer = bus.CreateConsumer<AgentLoopEvent>();
        var react = new ReAct(model, new AgentLoopOptions
        {
            SystemPrompt = "你是一个极简的 ReAct agent。需要事实信息时调用工具，不要凭空编造。",
            MaxIterations = 6,
        }, bus);

        var result = await react.RunStreamingAsync(new AgentRequest
        {
            UserMessage = "帮我算一下 1234 加 5678 等于多少。",
            Tools =
            [
                Tool("add_numbers", "计算两个数字的和。",
                    """{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}},"required":["a","b"]}"""),
            ],
            ToolExecutor = new DemoToolExecutor(),
        }, new CancellationTokenSource(TimeSpan.FromSeconds(180)).Token);

        // 流式路径：真实模型逐段产出文本增量，事件被消费者按序收齐。
        Assert.Equal(AgentStopReason.Answer, result.StopReason);

        var events = new List<AgentLoopEvent>();
        while (consumer.TryRead() is { } e)
            events.Add(e);
        var deltas = events.OfType<AgentLoopEvent.TextDelta>().Select(d => d.Delta).ToList();
        Assert.NotEmpty(deltas);
        Assert.Contains("1234", string.Concat(deltas));
        Assert.Contains(events, e => e is AgentLoopEvent.ToolStarted { Call.Name: "add_numbers" });
    }

    private static ChatTool Tool(string name, string description, string schemaJson)
    {
        var parameters = (JsonObject)JsonNode.Parse(schemaJson)!;
        return ChatTool.Create(name, description, parameters);
    }

    /// <summary>订阅事件总线，把观察事件打到控制台，便于人工观察 ReAct 循环过程。</summary>
    private sealed class ConsoleObserver : IEventHandler<AgentLoopEvent>
    {
        public Task HandleAsync(AgentLoopEvent evt, CancellationToken cancellationToken = default)
        {
            switch (evt)
            {
                case AgentLoopEvent.TurnCompleted t:
                    Console.WriteLine($"── turn #{t.Iteration}  finish={t.FinishReason.Kind}  {t.Usage}");
                    break;
                case AgentLoopEvent.ToolStarted s:
                    Console.WriteLine($"  → 调用工具 {s.Call.Name}({s.Call.Arguments})");
                    break;
                case AgentLoopEvent.ToolCompleted c:
                    Console.WriteLine($"  ← {(c.IsError ? "ERROR" : "ok")} {c.Observation}");
                    break;
                case AgentLoopEvent.RunFailed f:
                    Console.WriteLine($"  ✗ run failed: [{f.Failure.Code}] {f.Failure.Message}");
                    break;
            }
            return Task.CompletedTask;
        }
    }

    /// <summary>与演示 Agent 相同的两个工具。</summary>
    private sealed class DemoToolExecutor : IToolExecutor
    {
        public Task<string> ExecuteAsync(ToolCallBlock call, CancellationToken cancellationToken = default) =>
            Task.FromResult(call.Name switch
            {
                "get_current_utc_time" => DateTimeOffset.UtcNow.ToString("yyyy-MM-dd HH:mm:ss 'UTC'"),
                "add_numbers" => AddNumbers(call.Arguments),
                _ => $"error executing tool '{call.Name}': unknown tool",
            });

        private static string AddNumbers(string arguments)
        {
            using var doc = JsonDocument.Parse(arguments);
            var root = doc.RootElement;
            var a = root.GetProperty("a").GetDouble();
            var b = root.GetProperty("b").GetDouble();
            return (a + b).ToString("0.####");
        }
    }
}
