// ============================================================================
//  Di Harness —— 最小 Agent Loop（三层分离演示）
// ============================================================================
//
//  按照你的设计理念，这里演示三层如何协作：
//     Agent Loop      ← 本文件，只依赖 IChatModel（不碰厂商/注册表细节）
//     Model Abstraction ← Core/Llm/IChatModel + ChatModelClient
//     Provider Adapter  ← Core/Providers/DeepSeek（DeepSeek 适配器插件）
//
//  Agent 拿到的是一个"模型对象"，而不是"某个 SDK 的 client"：
//     var model = new ChatModelClient(llm, "deepseek", "deepseek-v4-pro");
//     // 换模型/换厂商：改这两个参数，或换成不同的 *Model。
//     var agent = new AgentLoop(model);
//     await agent.RunAsync("现在几点？…");

var apiKey = Environment.GetEnvironmentVariable("DEEPSEEK_API_KEY");
if (string.IsNullOrWhiteSpace(apiKey))
{
    Console.WriteLine("未设置环境变量 DEEPSEEK_API_KEY。");
    Console.WriteLine("请先执行：  set DEEPSEEK_API_KEY=sk-你的key");
    return 1;
}

// ---- 装配（组合根）：插线性。以后换厂商/加厂商只在这里加一行。----
using var host = new Core.Plugin.PluginHost();
host.Install(new Core.Plugin.SettingsPlugin());
host.Install(new Core.Llm.LlmPlugin());
host.Install(new Core.Providers.DeepSeek.DeepSeekChatProvider());
await host.InitializeAsync();

var llm = host.Get<Core.Llm.ILlmService>()
    ?? throw new InvalidOperationException("模型层未就绪。");

Console.WriteLine($"已注册 provider：{string.Join(", ", llm.ListProviders().Select(p => p.Name))}");

// ---- 关键：只实例化一个"模型对象"，交给 Agent Loop ----
var model = new Core.Llm.ChatModelClient(llm, "deepseek", "deepseek-v4-pro");
var agent = new AgentLoop(
    model,
    systemPrompt: "你是一个极简的 ReAct agent。需要事实信息时调用工具，不要凭空编造。拿到工具结果后给出简洁的中文回答。");

var exit = await agent.RunAsync("现在几点？另外帮我算一下 1234 加 5678 等于多少。");
return exit;

// ============================================================================
//  Agent Loop —— 只认识 IChatModel，不认识任何厂商。
//  这正是"把 Agent 和模型解耦"的最小证明。
// ============================================================================

file sealed class AgentLoop(Core.Llm.IChatModel model, string systemPrompt)
{
    private static readonly Core.Llm.ChatTool[] Tools =
    [
        // 需要 JsonObject 形式的 JSON Schema
        Tool("get_current_utc_time", "获取当前的 UTC 时间。参数为空。", """{"type":"object","properties":{},"required":[]}"""),
        Tool("add_numbers", "计算两个数字的和。当用户需要算术结果时使用。",
            """{"type":"object","properties":{"a":{"type":"number","description":"第一个加数"},"b":{"type":"number","description":"第二个加数"}},"required":["a","b"]}"""),
    ];

    public async Task<int> RunAsync(string userRequest)
    {
        var history = new List<Core.Llm.ChatMessage>
        {
            Core.Llm.ChatMessage.System(systemPrompt),
            Core.Llm.ChatMessage.User(userRequest),
        };

        var totalUsage = Core.Llm.TokenUsage.Zero;
        const int MaxSubTurns = 6;

        for (var subTurn = 1; subTurn <= MaxSubTurns; subTurn++)
        {
            Console.WriteLine($"\n──── ReAct #{subTurn} " + new string('─', 46));

            var request = new Core.Llm.ModelRequest
            {
                Messages = [.. history],
                Tools = Tools,
                ReasoningEffort = "high",
                MaxTokens = 65536,
            };

            var response = await model.CompleteAsync(request);

            totalUsage = totalUsage.Add(response.Usage);
            Console.WriteLine($"[usage] {response.Usage}  finish={response.FinishReason.Kind ?? "?"}");

            // 关键：整条 assistant 消息原样入历史（含推理链与工具调用）。
            history.Add(response.Message);

            var toolCalls = response.Message.ToolCalls;
            if (toolCalls.Count == 0)
            {
                Console.WriteLine($"\n──── 最终回答 " + new string('─', 46));
                Console.WriteLine(Core.Llm.ChatMessageExtensions.GetText(response.Message));
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
                catch
                {
                    result = """{"error":"工具执行失败"}""";
                }

                Console.WriteLine($"  ← 结果 {result}");
                history.Add(Core.Llm.ChatMessage.Tool(call.Id, result));
            }
        }

        Console.WriteLine($"\n达到子轮上限 {MaxSubTurns}，仍未收敛。累计用量：{totalUsage}");
        return 1;
    }

    private static string ExecuteTool(Core.Llm.ToolCallBlock call) => call.Name switch
    {
        "get_current_utc_time" => DateTimeOffset.UtcNow.ToString("yyyy-MM-dd HH:mm:ss 'UTC'"),
        "add_numbers" => ExecuteAddNumbers(call.Arguments),
        _ => throw new InvalidOperationException($"未知工具 '{call.Name}'。"),
    };

    private static string ExecuteAddNumbers(string arguments)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(arguments);
            var root = doc.RootElement;
            if (!root.TryGetProperty("a", out var a) || !root.TryGetProperty("b", out var b))
                return """{"error":"缺少参数 a 或 b"}""";
            return (a.GetDouble() + b.GetDouble()).ToString("0.####");
        }
        catch (System.Text.Json.JsonException)
        {
            return """{"error":"arguments 不是合法 JSON"}""";
        }
    }

    private static Core.Llm.ChatTool Tool(string name, string description, string schemaJson)
    {
        var parameters = (System.Text.Json.Nodes.JsonObject)System.Text.Json.Nodes.JsonNode.Parse(schemaJson)!;
        return new Core.Llm.ChatTool { Name = name, Description = description, Parameters = parameters };
    }
}