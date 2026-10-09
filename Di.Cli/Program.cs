using Common.Events;
using Core.AgentLoop;
using Core.Configuration;
using Core.Llm;
using Core.Sessions;
using Core.Skills;
using Core.Tools;
using Di.Cli;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

// 组合根：分层配置（appsettings → ~/.di/config.json → <workspace>/.di/config.json → 环境变量）
// → AddDi() 装配模型层与事件总线。
var diHome = DiHome.Resolve();
var workspace = Directory.GetCurrentDirectory();
var configuration = DiConfig.Load(workspace, diHome.RootDirectory);

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

var agentLoop = provider.GetRequiredService<IOptions<AgentLoopOptions>>().Value;
var modelOptions = provider.GetRequiredService<IOptions<ModelOptions>>().Value;
var replOptions = provider.GetRequiredService<IOptions<ReplOptions>>().Value;

using var executor = CoreTools.CreateExecutor(workspace);

// Skills：两级发现（用户 ~/.di/skills + 项目 .di/skills，项目覆盖同名用户级）；无效文件只告警。
// 传给 AgentRunner（广告块 + load_skill 工具）与 Repl（列表 / 自动匹配）。
var skills = SkillRepository.Load(
    diHome.SkillsDirectory,
    Path.Combine(DiHome.ProjectDirectory(workspace), "skills"),
    warn: msg => Console.Error.WriteLine($"⚠ {msg}"));

// 默认提示词 = 内置工具说明 + 简洁助手人格；配置里显式写了 AgentLoop:SystemPrompt 则整体覆盖。
var systemPrompt = string.IsNullOrWhiteSpace(agentLoop.SystemPrompt)
    ? CoreTools.Instructions + "\n\n" +
      "你是一个简洁的 ReAct 助手。需要事实信息时调用工具，不要编造。回答用中文。"
    : agentLoop.SystemPrompt;

var runner = new AgentRunner(
    provider.GetRequiredService<Func<string, IChatModel>>(),
    executor,
    new AgentLoopOptions
    {
        SystemPrompt = systemPrompt,
        MaxIterations = agentLoop.MaxIterations,
    },
    provider.GetRequiredService<IEventBus>(),
    CoreTools.Definitions(workspace),
    workingDirectory: workspace,
    skills: skills)
{
    // 默认模型来自配置（Model:DefaultModel），之后仍可 /model 切换。
    CurrentModel = modelOptions.DefaultModel,
};

// 会话持久化：整个 CLI 运行写成一个 JSONL（~/.di/sessions/YYYY/MM/DD/）。
// 记录为尽力而为——磁盘错误只告警，绝不中断聊天。
var sessionLog = new SessionLog(new SessionLogOptions { RootDirectory = diHome.RootDirectory });

// 输出重定向（管道/文件）时不写 ANSI 控制序列，避免污染捕获输出（覆盖配置默认）。
if (Console.IsOutputRedirected)
    replOptions.UseAnsi = false;

var repl = new Repl(
    runner,
    provider.GetRequiredService<IEventBus>(),
    new ConsoleLineReader(),
    Console.Out,
    replOptions,
    sessionLog,
    skills);

await repl.RunAsync();
return 0;
