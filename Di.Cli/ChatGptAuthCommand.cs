using Core.Configuration;
using Core.Llm;
using Core.Providers.ChatGpt;
using Microsoft.Extensions.DependencyInjection;

namespace Di.Cli;

internal static class ChatGptAuthCommand
{
    public static async Task<int> RunAsync(string[] args, TextWriter stdout, TextWriter stderr, CancellationToken ct)
    {
        if (args.Length < 3 || args[1] != "chatgpt" || args.Length > 5)
        {
            await stderr.WriteLineAsync("Usage: di auth chatgpt login [--new] [--consent] | status | logout | models");
            return 1;
        }
        var services = new ServiceCollection();
        services.AddSingleton(DiHome.Resolve());
        services.AddChatGpt();
        using var provider = services.BuildServiceProvider();
        var auth = provider.GetRequiredService<ChatGptAuth>();
        try
        {
            switch (args[2])
            {
                case "login":
                    if (args.Skip(3).Any(a => a is not ("--consent" or "--new"))) throw new ArgumentException("Use --new to register another ChatGPT connection.");
                    await stdout.WriteLineAsync("Continue with ChatGPT — complete authorization in your browser (5 minute timeout).");
                    await auth.SignInAsync(ChatGptAuth.OpenSystemBrowserAsync, args.Contains("--new"), args.Contains("--consent"), ct);
                    await stdout.WriteLineAsync("ChatGPT connected. Run di auth chatgpt models to list models.");
                    break;
                case "status" when args.Length == 3:
                    var status = await auth.StatusAsync(ct);
                    await stdout.WriteLineAsync($"ChatGPT: signed_in={status.SignedIn} plan={status.PlanEnabled} client_id={status.ClientId ?? "none"}");
                    break;
                case "logout" when args.Length == 3:
                    var revoked = await auth.SignOutAsync(ct);
                    await stdout.WriteLineAsync(revoked ? "Signed out of ChatGPT." :
                        "Signed out locally. Remote revocation was not confirmed; disconnect the app in ChatGPT Settings.");
                    break;
                case "models" when args.Length == 3:
                    foreach (var model in await provider.GetRequiredService<ChatGptAdapter>().RefreshModelsAsync(ct))
                        await stdout.WriteLineAsync($"chatgpt/{model.Id}  {model.Name}");
                    break;
                default: throw new ArgumentException("Unknown ChatGPT auth command or arguments.");
            }
            return 0;
        }
        catch (Exception ex) when (ex is LlmException or InvalidDataException or IOException or InvalidOperationException or ArgumentException or HttpRequestException or OperationCanceledException)
        {
            // Do not print exception details from OAuth internals; they can contain sensitive URLs.
            await stderr.WriteLineAsync(ex is LlmException or InvalidDataException or ArgumentException ? $"ChatGPT: {ex.Message}" :
                ex is OperationCanceledException ? "ChatGPT authorization cancelled or timed out." : "ChatGPT command failed: " + ex.GetType().Name);
            return 1;
        }
    }
}
