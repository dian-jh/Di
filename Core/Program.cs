using System.Text.Json;
using System.Text.Json.Nodes;
using Core.Llm;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

// ============================================================================
//  Di Harness —— 最小 Agent Loop（三层分离演示）
// ============================================================================
//
//     Agent Loop        ← 本文件，只依赖 IChatModel（不碰厂商/注册表细节）
//     Model Abstraction ← Core/Llm/IChatModel + ChatModelClient
//     Provider Adapter  ← Core/Providers/DeepSeek（DeepSeek 适配器）
//
//  组合根用 .NET 原生的 Hosting + DI + Options + Logging，不再手写插件容器：
//     AddLlm()      —— 模型层（LlmRuntime）注册为 DI 单例
//     AddDeepSeek() —— DeepSeek 适配器（配置绑定 + 命名 HttpClient + 注册）
//  换模型/换厂商：改 appsettings.json 的 AgentLoop 段，或加一个 *ServiceCollectionExtensions。
//
//  Agent 拿到的是一个"模型对象"，而不是"某个 SDK 的 client"：
//     var model = new ChatModelClient(llm, "deepseek", "deepseek-v4-pro");
// ============================================================================

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddLlm();
builder.Services.AddDeepSeek();

builder.Services.Configure<AgentLoopOptions>(builder.Configuration.GetSection("AgentLoop"));

builder.Services.AddSingleton<IChatModel>(sp => new ChatModelClient(
    sp.GetRequiredService<ILlmService>(),
    sp.GetRequiredService<IOptions<AgentLoopOptions>>().Value.Provider,
    sp.GetRequiredService<IOptions<AgentLoopOptions>>().Value.Model));

builder.Services.AddHostedService<AgentLoop>();

using var host = builder.Build();
try
{
    await host.RunAsync();
}
catch (Exception ex)
{
    Console.WriteLine($"启动失败：{ex.Message}");
    return 1;
}

return 0;

// ============================================================================
//  Agent Loop —— 只认识 IChatModel，不认识任何厂商。
//  这正是"把 Agent 和模型解耦"的最小证明。
// ============================================================================

file sealed class AgentLoopOptions
{
    public string Provider { get; set; } = "deepseek";
    public string Model { get; set; } = "deepseek-v4-pro";
    public string SystemPrompt { get; set; } =
        "你是一个极简的 ReAct agent。需要事实信息时调用工具，不要凭空编造。拿到工具结果后给出简洁的中文回答。";
}

file sealed class AgentLoop(
    IChatModel model,
    ILlmService llm,
    IOptions<AgentLoopOptions> options,
    ILogger<AgentLoop> logger,
    IHostApplicationLifetime lifetime) : IHostedService
{
    private static readonly ChatTool[] Tools =
    [
        // 需要 JsonObject 形式的 JSON Schema
        Tool("get_current_utc_time", "获取当前的 UTC 时间。参数为空。", """{"type":"object","properties":{},"required":[]}"""),
        Tool("add_numbers", "计算两个数字的和。当用户需要算术结果时使用。",
            """{"type":"object","properties":{"a":{"type":"number","description":"第一个加数"},"b":{"type":"number","description":"第二个加数"}},"required":["a","b"]}"""),
    ];

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        logger.LogInformation("已注册 provider：{Providers}",
            string.Join(", ", llm.ListProviders().Select(p => p.Name)));

        var exit = await RunLoopAsync();

        Environment.ExitCode = exit;
        lifetime.StopApplication();
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private async Task<int> RunLoopAsync()
    {
        var history = new List<ChatMessage>
        {
            ChatMessage.System(options.Value.SystemPrompt),
            ChatMessage.User("现在几点？另外帮我算一下 1234 加 5678 等于多少。"),
        };

        var totalUsage = TokenUsage.Zero;
        const int MaxSubTurns = 6;

        for (var subTurn = 1; subTurn <= MaxSubTurns; subTurn++)
        {
            Console.WriteLine($"\n──── ReAct #{subTurn} " + new string('─', 46));

            var request = new ModelRequest
            {
                Messages = [.. history],
                Tools = Tools,
                ReasoningEffort = "high",
                MaxTokens = 65536,
            };

            var response = await model.CompleteAsync(request);

            totalUsage = totalUsage.Add(response.Usage);
            logger.LogInformation("[usage] {Usage}  finish={Finish}", response.Usage, response.FinishReason.Kind ?? "?");

            // 关键：整条 assistant 消息原样入历史（含推理链与工具调用）。
            history.Add(response.Message);

            var toolCalls = response.Message.ToolCalls;
            if (toolCalls.Count == 0)
            {
                Console.WriteLine($"\n──── 最终回答 " + new string('─', 46));
                Console.WriteLine(ChatMessageExtensions.GetText(response.Message));
                Console.WriteLine($"\n累计用量：{totalUsage}");
                return 0;
            }

            foreach (var call in toolCalls)
            {
                Console.ForegroundColor = ConsoleColor.Cyan;
                Console.WriteLine($"  → 调用工具 {call.Name}({call.Arguments})");
                Console.ResetColor();

                string result;
                try
                {
                    result = ExecuteTool(call);
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "工具 {Tool} 执行失败", call.Name);
                    result = """{"error":"工具执行失败"}""";
                }

                Console.WriteLine($"  ← 结果 {result}");
                history.Add(ChatMessage.Tool(call.Id, result));
            }
        }

        Console.WriteLine($"\n达到子轮上限 {MaxSubTurns}，仍未收敛。累计用量：{totalUsage}");
        return 1;
    }

    private static string ExecuteTool(ToolCallBlock call) => call.Name switch
    {
        "get_current_utc_time" => DateTimeOffset.UtcNow.ToString("yyyy-MM-dd HH:mm:ss 'UTC'"),
        "add_numbers" => ExecuteAddNumbers(call.Arguments),
        _ => throw new InvalidOperationException($"未知工具 '{call.Name}'。"),
    };

    private static string ExecuteAddNumbers(string arguments)
    {
        try
        {
            using var doc = JsonDocument.Parse(arguments);
            var root = doc.RootElement;
            if (!root.TryGetProperty("a", out var a) || !root.TryGetProperty("b", out var b))
                return """{"error":"缺少参数 a 或 b"}""";
            return (a.GetDouble() + b.GetDouble()).ToString("0.####");
        }
        catch (JsonException)
        {
            return """{"error":"arguments 不是合法 JSON"}""";
        }
    }

    private static ChatTool Tool(string name, string description, string schemaJson)
    {
        var parameters = (JsonObject)JsonNode.Parse(schemaJson)!;
        return new ChatTool { Name = name, Description = description, Parameters = parameters };
    }
}
