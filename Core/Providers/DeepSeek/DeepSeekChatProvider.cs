using Core.Llm;
using Core.Plugin;

namespace Core.Providers.DeepSeek;

/// <summary>
/// DeepSeek 适配器插件。声明依赖 llm + settings，把自身作为 provider 适配器注册到模型层。
///
/// 这就是"everything is a plugin"的形态：加厂商 = 加一个这样的插件，
/// 通过 <c>registerAdapter</c> 上报自己的 provider 路由，宿主与业务代码都不需要改。
/// </summary>
public sealed class DeepSeekChatProvider : IPlugin
{
    private readonly HttpClient? _http;
    private readonly DeepSeekAdapterConfig? _configOverride;

    private IAdapterRegistration? _registration;

    public DeepSeekChatProvider(HttpClient? http = null, DeepSeekAdapterConfig? config = null)
    {
        _http = http;
        _configOverride = config;
    }

    public string Name => "deepseek";

    public IReadOnlyList<string> Inject => ["llm", "settings"];

    public void Apply(IPluginContext context)
    {
        context.Inject(["llm", "settings"], ready =>
        {
            var llm = ready.Get<ILlmService>()
                ?? throw new InvalidOperationException("缺少 llm 服务。");
            var settings = ready.Get<ISettingsService>();

            var config = _configOverride
                ?? settings?.GetSection<DeepSeekAdapterConfig>("DeepSeek")
                ?? new DeepSeekAdapterConfig();

            var apiKey = config.ApiKey
                ?? Environment.GetEnvironmentVariable(DeepSeekDefaults.ApiKeyEnvironmentVariable)
                ?? string.Empty;

            // strict 模式需要 beta 端点；否则用通用端点。
            var baseUrl = config.BaseUrl
                ?? (config.StrictTools ? DeepSeekDefaults.BetaEndpoint : DeepSeekDefaults.Endpoint);

            var http = _http ?? ChatHttp.Default();
            var adapter = new DeepSeekAdapter(http, apiKey, config, baseUrl);

            _registration = llm.RegisterAdapter([DeepSeekDefaults.ProviderId], adapter);
        });
    }
}

/// <summary>DeepSeek 插件自用的 HttpClient 工厂（不污染其它插件的共享 client）。</summary>
internal static class ChatHttp
{
    public static HttpClient Default() => new();
}