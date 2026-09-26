using Core.Llm;
namespace Microsoft.Extensions.DependencyInjection;

/// <summary>
/// 模型层（对应 DSH 的 LlmRuntime）的 DI 装配扩展。
///
/// 适配器以 <see cref="ChatAdapter"/> 注册进容器（如 <c>AddDeepSeek()</c>），
/// 这里在首次解析 <see cref="ILlmService"/> 时收集全部适配器，按 <see cref="ChatAdapter.ProviderIds"/>
/// 装入 LlmRuntime 的路由表 —— "注册"交给 DI，路由/分发仍是 LlmRuntime 的职责。
/// </summary>
public static class LlmServiceCollectionExtensions
{
    public static IServiceCollection AddLlm(this IServiceCollection services)
    {
        services.AddSingleton<ILlmService>(sp =>
        {
            var adapters = sp.GetServices<ChatAdapter>().ToList();
            if (adapters.Count == 0)
                throw new InvalidOperationException(
                    "未注册任何 ChatAdapter（例如调用 AddDeepSeek()）。模型层没有可用的 provider。");

            var runtime = new LlmRuntime();
            foreach (var adapter in adapters)
            {
                if (adapter.ProviderIds.Count == 0)
                    throw new InvalidOperationException(
                        $"适配器 {adapter.GetType().Name} 未声明 ProviderIds，无法装入路由表。");
                runtime.RegisterAdapter(adapter.ProviderIds.ToArray(), adapter);
            }

            return runtime;
        });

        return services;
    }
}
