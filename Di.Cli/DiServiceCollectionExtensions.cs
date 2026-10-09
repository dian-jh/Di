using Common.Events;
using Core.AgentLoop;
using Core.Configuration;
using Core.Llm;
using Core.Providers.DeepSeek;
using Di.Cli;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Microsoft.Extensions.DependencyInjection;

/// <summary>
/// Di CLI 的组合扩展：装配模型层 + 事件总线 + 重试装饰的模型工厂 + 各配置段绑定。
/// 宿主只需「构建配置 → AddDi() → 从容器解析」，加 provider / 改配置都不碰宿主。
/// 配置分层见 <see cref="DiConfig"/>：用户可在 ~/.di/config.json 或项目 .di/config.json 覆盖任意段。
/// </summary>
public static class DiServiceCollectionExtensions
{
    public static IServiceCollection AddDi(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddSingleton<IConfiguration>(configuration);
        services.AddSingleton(DiHome.Resolve());   // 家目录：配置/会话/skills/MCP 的统一来源

        // 模型层：LlmRuntime 路由 + DeepSeek 适配器（配置段 "DeepSeek"，ApiKey 缺省读环境变量）。
        services.AddLlm();
        services.AddDeepSeek();

        // 事件总线：ReAct 循环事件经它发布，UI / 会话记录从同一总线消费；处理异常只告警不中断。
        services.AddEventBus(o => o.OnHandlerError = (ex, evt) =>
        {
            Console.Error.WriteLine($"事件处理失败: {ex.Message}");
            return Task.CompletedTask;
        });

        // 配置段绑定（缺省值见各类本身，用户/项目配置只做覆盖）。
        services.AddOptions<AgentLoopOptions>().BindConfiguration("AgentLoop");
        services.AddOptions<ModelOptions>().BindConfiguration("Model");
        services.AddOptions<ReplOptions>().BindConfiguration("Repl");
        services.AddOptions<RetryPolicyOptions>().BindConfiguration("Retry");

        // 模型工厂：按 Model:Provider 选适配器，默认套上重试装饰器——限流/超时/5xx 等可重试故障
        // 按指数退避重试（尊重 Retry-After），对 ReAct 透明。
        services.AddSingleton<Func<string, IChatModel>>(sp =>
        {
            var llm = sp.GetRequiredService<ILlmService>();
            var retry = sp.GetRequiredService<IOptions<RetryPolicyOptions>>().Value;
            var model = sp.GetRequiredService<IOptions<ModelOptions>>().Value;
            return name => new RetryingChatModel(new ChatModelClient(llm, model.Provider, name), retry);
        });

        return services;
    }
}
