using Core.Configuration;
using Core.Llm;
using Core.Providers.ChatGpt;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Microsoft.Extensions.DependencyInjection;

public static class ChatGptServiceCollectionExtensions
{
    public static IServiceCollection AddChatGpt(this IServiceCollection services)
    {
        services.TryAddSingleton(_ => DiHome.Resolve());
        services.AddSingleton<ChatGptCredentialStore>();
        services.AddHttpClient("chatgpt-auth", client => client.Timeout = TimeSpan.FromSeconds(60))
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false });
        services.AddHttpClient("chatgpt", client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false });
        services.AddSingleton(sp => new ChatGptAuth(sp.GetRequiredService<IHttpClientFactory>().CreateClient("chatgpt-auth"),
            sp.GetRequiredService<ChatGptCredentialStore>()));
        services.AddSingleton(sp => new ChatGptAdapter(sp.GetRequiredService<IHttpClientFactory>().CreateClient("chatgpt"), sp.GetRequiredService<ChatGptAuth>()));
        services.AddSingleton<ChatAdapter>(sp => sp.GetRequiredService<ChatGptAdapter>());
        return services;
    }
}
