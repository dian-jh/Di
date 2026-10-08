using Common.Events;
using Core.AgentLoop;
using Core.Llm;
using Core.Providers.DeepSeek;
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

var llm = provider.GetRequiredService<ILlmService>();
Func<string, IChatModel> modelFactory = name => new ChatModelClient(llm, "deepseek", name);

var runner = new AgentRunner(
    modelFactory,
    new DemoTools.Executor(),
    new AgentLoopOptions
    {
        SystemPrompt = "你是一个简洁的 ReAct 助手。需要事实信息时调用工具，不要编造。回答用中文。",
        MaxIterations = 8,
    },
    provider.GetRequiredService<IEventBus>(),
    DemoTools.Definitions);

var repl = new Repl(
    runner,
    provider.GetRequiredService<IEventBus>(),
    new ConsoleLineReader(),
    Console.Out,
    new ReplOptions());

await repl.RunAsync();
