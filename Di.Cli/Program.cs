using Common.Events;
using Core.AgentLoop;
using Core.Llm;
using Core.Providers.DeepSeek;
using Core.Tools;
using Di.Cli;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

// 组合根：装配模型层（DeepSeek）+ 事件总线 + CLI。
var services = new ServiceCollection();
services.AddSingleton<IConfiguration>(new ConfigurationBuilder().Build());
services.AddLlm();
services.AddDeepSeek();
services.AddEventBus(o => o.OnHandlerError = (ex, evt) =>
{
    Console.Error.WriteLine($"事件处理失败: {ex.Message}");
    return Task.CompletedTask;
});
await using var provider = services.BuildServiceProvider();

ILlmService llm;
try
{
    // 首次解析会触发适配器装配；DeepSeek API Key 缺失时在这里抛 InvalidOperationException。
    llm = provider.GetRequiredService<ILlmService>();
}
catch (InvalidOperationException ex)
{
    Console.Error.WriteLine($"模型层初始化失败: {ex.Message}");
    if (ex.Message.Contains("API Key", StringComparison.OrdinalIgnoreCase))
        Console.Error.WriteLine("提示：请先设置环境变量 DEEPSEEK_API_KEY 再运行。");
    return 1;
}

Func<string, IChatModel> modelFactory = name => new ChatModelClient(llm, "deepseek", name);

var workspace = Directory.GetCurrentDirectory();

var runner = new AgentRunner(
    modelFactory,
    CoreTools.CreateExecutor(workspace),
    new AgentLoopOptions
    {
        // stable_prefix：核心工具使用说明（七个内置编码工具）始终在系统提示最前面。
        SystemPrompt = CoreTools.Instructions + "\n\n" +
                       "你是一个简洁的 ReAct 助手。需要事实信息时调用工具，不要编造。回答用中文。",
        MaxIterations = 8,
    },
    provider.GetRequiredService<IEventBus>(),
    CoreTools.Definitions(workspace));

var repl = new Repl(
    runner,
    provider.GetRequiredService<IEventBus>(),
    new ConsoleLineReader(),
    Console.Out,
    new ReplOptions
    {
        // 输出重定向（管道/文件）时不写 ANSI 控制序列，避免污染捕获输出。
        UseAnsi = !Console.IsOutputRedirected,
    });

await repl.RunAsync();
return 0;
