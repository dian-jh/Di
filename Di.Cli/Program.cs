using Common.Events;
using Core.AgentLoop;
using Core.Llm;
using Core.Sessions;
using Core.Tools;
using Di.Cli;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

// 组合根：加载真实配置（appsettings.json + 环境变量）→ AddDi() 装配模型层与事件总线。
var configuration = new ConfigurationBuilder()
    .SetBasePath(AppContext.BaseDirectory)   // appsettings.json 随构建拷贝到输出目录
    .AddJsonFile("appsettings.json", optional: true, reloadOnChange: false)
    .AddEnvironmentVariables()
    .Build();

var services = new ServiceCollection();
services.AddDi(configuration);
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

var workspace = Directory.GetCurrentDirectory();

using var executor = CoreTools.CreateExecutor(workspace);

var runner = new AgentRunner(
    provider.GetRequiredService<Func<string, IChatModel>>(),
    executor,
    new AgentLoopOptions
    {
        // stable_prefix：核心工具使用说明（七个内置编码工具）始终在系统提示最前面。
        SystemPrompt = CoreTools.Instructions + "\n\n" +
                       "你是一个简洁的 ReAct 助手。需要事实信息时调用工具，不要编造。回答用中文。",
        MaxIterations = 8,
    },
    provider.GetRequiredService<IEventBus>(),
    CoreTools.Definitions(workspace),
    workingDirectory: workspace);

// 会话持久化：整个 CLI 运行写成一个 JSONL（~/.di/sessions/YYYY/MM/DD/）。
// 记录为尽力而为——磁盘错误只告警，绝不中断聊天。
var sessionLog = new SessionLog(new SessionLogOptions());

var repl = new Repl(
    runner,
    provider.GetRequiredService<IEventBus>(),
    new ConsoleLineReader(),
    Console.Out,
    new ReplOptions
    {
        // 输出重定向（管道/文件）时不写 ANSI 控制序列，避免污染捕获输出。
        UseAnsi = !Console.IsOutputRedirected,
    },
    sessionLog);

await repl.RunAsync();
return 0;
