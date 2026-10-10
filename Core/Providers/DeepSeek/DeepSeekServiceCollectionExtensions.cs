using Core.Llm;
using Core.Providers.DeepSeek;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Microsoft.Extensions.DependencyInjection;

/// <summary>
/// DeepSeek 适配器的 DI 装配扩展（对应 DSH 的 llm-deepseek 插件）。
///
/// 注册三样东西：
/// <list type="bullet">
/// <item>配置绑定：appsettings.json 的 "DeepSeek" 段 → <see cref="DeepSeekAdapterConfig"/>（IOptions）。</item>
/// <item>命名 HttpClient（IHttpClientFactory）：每个 provider 一个命名 client，生命周期/连接池归框架管。</item>
/// <item>适配器单例：apiKey / baseUrl 的缺省回退（环境变量、strict 端点）在这里解析。</item>
/// </list>
/// 加厂商 = 加一个这样的扩展方法，宿主与业务代码不用改。
/// </summary>
public static class DeepSeekServiceCollectionExtensions
{
    public static IServiceCollection AddDeepSeek(this IServiceCollection services)
    {
        services.AddOptions<DeepSeekAdapterConfig>().BindConfiguration("DeepSeek");
        services.AddHttpClient(DeepSeekDefaults.ProviderId)
            .ConfigureHttpClient((sp, client) => client.Timeout =
                TimeSpan.FromSeconds(sp.GetRequiredService<IOptions<DeepSeekAdapterConfig>>().Value.TimeoutSeconds));

        // API Key 不再在装配时解析/抛错：缺省读环境变量，由 LlmRuntime 在<b>请求时</b>经凭证存储解析
        // （宿主无密钥也能启动，UI 显示"未配置"）。
        services.AddSingleton<ChatAdapter>(sp =>
        {
            var config = sp.GetRequiredService<IOptions<DeepSeekAdapterConfig>>().Value;

            var baseUrl = config.BaseUrl
                ?? (config.StrictTools ? DeepSeekDefaults.BetaEndpoint : DeepSeekDefaults.Endpoint);

            var http = sp.GetRequiredService<IHttpClientFactory>().CreateClient(DeepSeekDefaults.ProviderId);
            return new DeepSeekAdapter(http, config, baseUrl);
        });

        return services;
    }
}
