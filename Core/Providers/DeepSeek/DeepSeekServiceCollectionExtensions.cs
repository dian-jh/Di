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

        services.AddSingleton<ChatAdapter>(sp =>
        {
            var config = sp.GetRequiredService<IOptions<DeepSeekAdapterConfig>>().Value;

            var apiKey = config.ApiKey
                ?? Environment.GetEnvironmentVariable(DeepSeekDefaults.ApiKeyEnvironmentVariable)
                ?? string.Empty;
            if (string.IsNullOrWhiteSpace(apiKey))
                throw new InvalidOperationException(
                    "未配置 DeepSeek API Key：请设置环境变量 DEEPSEEK_API_KEY 或 appsettings.json 的 DeepSeek:ApiKey。");

            var baseUrl = config.BaseUrl
                ?? (config.StrictTools ? DeepSeekDefaults.BetaEndpoint : DeepSeekDefaults.Endpoint);

            var http = sp.GetRequiredService<IHttpClientFactory>().CreateClient(DeepSeekDefaults.ProviderId);
            return new DeepSeekAdapter(http, apiKey, config, baseUrl);
        });

        return services;
    }
}
