using Common.Events;
using Core.Llm;
using Core.Providers.DeepSeek;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Microsoft.Extensions.DependencyInjection;

/// <summary>
/// Di CLI 的组合扩展：装配模型层 + 事件总线 + 重试装饰的模型工厂。
/// 宿主只需「构建配置 → AddDi() → 从容器解析」，加 provider / 改配置都不碰宿主。
/// </summary>
public static class DiServiceCollectionExtensions
{
    public static IServiceCollection AddDi(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddSingleton<IConfiguration>(configuration);

        // 模型层：LlmRuntime 路由 + DeepSeek 适配器（配置段 "DeepSeek"，ApiKey 缺省读环境变量）。
        services.AddLlm();
        services.AddDeepSeek();

        // 事件总线：ReAct 循环事件经它发布，UI / 会话记录从同一总线消费；处理异常只告警不中断。
        services.AddEventBus(o => o.OnHandlerError = (ex, evt) =>
        {
            Console.Error.WriteLine($"事件处理失败: {ex.Message}");
            return Task.CompletedTask;
        });

        // 模型工厂：默认套上重试装饰器——限流/超时/5xx 等可重试故障按指数退避重试（尊重 Retry-After），
        // 对 ReAct 透明；重试策略可经配置段 "Retry" 覆盖（缺省见 RetryPolicyOptions）。
        services.AddOptions<RetryPolicyOptions>().BindConfiguration("Retry");
        services.AddSingleton<Func<string, IChatModel>>(sp =>
        {
            var llm = sp.GetRequiredService<ILlmService>();
            var retry = sp.GetRequiredService<IOptions<RetryPolicyOptions>>().Value;
            return name => new RetryingChatModel(new ChatModelClient(llm, "deepseek", name), retry);
        });

        return services;
    }
}
