using System.Runtime.CompilerServices;
using System.Text.Json;
using Common.Events;
using Core.AgentLoop;
using Core.ContextManagement;
using Core.Llm;
using Di.Cli.Modes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Di.Cli.Tests;

public sealed class ModelSelectionTests
{
    private static (LlmRuntime Llm, FakeRunner Runner, ModelSelection Selection, Adapter ChatGpt) Setup()
    {
        var llm = new LlmRuntime();
        llm.RegisterAdapter(["deepseek"], new Adapter("deepseek", [new("deepseek-flash", "Flash"), new("shared", "Shared")]));
        var chatgpt = new Adapter("chatgpt", [new("account-model", "Account model"), new("shared", "Shared")]);
        llm.RegisterAdapter(["chatgpt"], chatgpt);
        var runner = new FakeRunner();
        return (llm, runner, new ModelSelection(llm, runner), chatgpt);
    }

    [Theory]
    [InlineData("chatgpt/account-model")]
    [InlineData("ACCOUNT-MODEL")]
    [InlineData("Account model")]
    public async Task Select_ResolvesProviderAndUniqueNames(string query)
    {
        var (_, runner, selection, _) = Setup();
        var selected = await selection.SelectAsync(query);
        Assert.Equal("chatgpt", selected.Provider);
        Assert.Equal("account-model", selected.Id);
        Assert.Equal("chatgpt/account-model", runner.CurrentModel);
        await selection.SelectAsync("deepseek/deepseek-flash");
        Assert.Equal("deepseek-flash", runner.CurrentModel);
    }

    [Theory]
    [InlineData("shared")]
    [InlineData("no-such-model")]
    [InlineData("unknown/account-model")]
    [InlineData("chatgpt/")]
    [InlineData("")]
    public async Task InvalidOrAmbiguousSelection_PreservesCurrentModel(string query)
    {
        var (_, runner, selection, _) = Setup();
        await Assert.ThrowsAsync<ArgumentException>(() => selection.SelectAsync(query));
        Assert.Equal("deepseek-flash", runner.CurrentModel);
    }

    [Fact]
    public async Task MissingAuth_PreservesCurrentModelWithoutRefreshing()
    {
        var (_, runner, selection, chatgpt) = Setup();
        chatgpt.Configured = false;
        var ex = await Assert.ThrowsAsync<LlmException>(() => selection.SelectAsync("chatgpt/account-model"));
        Assert.Equal(LlmErrorCodes.MissingCredential, ex.Code);
        Assert.Equal("deepseek-flash", runner.CurrentModel);
        Assert.Equal(0, chatgpt.Refreshes);
    }

    [Fact]
    public async Task ProviderSwitch_ResetsProviderSpecificReasoningOnlyAfterSuccess()
    {
        var (llm, runner, _, chatgpt) = Setup();
        var resets = 0;
        using var host = new CliHost(runner, new InMemoryEventBus(), llm, [], new ReplOptions(),
            reasoningEffort: "max", resetReasoning: () => resets++);
        chatgpt.Configured = false;
        await Assert.ThrowsAsync<LlmException>(() => host.Models.SelectAsync("chatgpt/account-model"));
        Assert.Equal("max", host.ReasoningEffort);
        Assert.Equal(0, resets);
        chatgpt.Configured = true;
        await host.Models.SelectAsync("chatgpt/account-model");
        Assert.Null(host.ReasoningEffort);
        Assert.Equal(1, resets);
    }

    [Fact]
    public async Task QualifiedId_AllowsModelsAbsentFromAdvisoryCatalog()
    {
        var (_, runner, selection, _) = Setup();
        await selection.SelectAsync("chatgpt/new-model");
        Assert.Equal("chatgpt/new-model", runner.CurrentModel);
    }

    [Fact]
    public async Task Factory_RoutesSelectedProviderInsteadOfStartupProvider()
    {
        var (llm, runner, selection, chatgpt) = Setup();
        var services = new ServiceCollection();
        services.AddDi(new ConfigurationBuilder().Build());
        services.AddSingleton<ILlmService>(llm);
        using var provider = services.BuildServiceProvider();
        var factory = provider.GetRequiredService<Func<string, IChatModel>>();
        await selection.SelectAsync("chatgpt/account-model");
        await factory(runner.CurrentModel).CompleteAsync(new ModelRequest { Messages = [ChatMessage.User("hi")] });
        Assert.Equal("chatgpt", chatgpt.LastRequest!.Provider);
        Assert.Equal("account-model", chatgpt.LastRequest.Model);
    }

    [Fact]
    public async Task RpcAndSlashCommand_ShareValidationAndQualifiedCatalog()
    {
        var (llm, runner, _, _) = Setup();
        using var host = new CliHost(runner, new InMemoryEventBus(), llm, [], new ReplOptions());
        using var output = new StringWriter();
        await RpcMode.RunAsync(host, new CliArgs { NoSession = true }, new StringReader("""
            {"method":"set_model","params":{"model":"chatgpt/account-model"}}
            {"method":"command","params":{"name":"model","args":"missing"}}
            {"method":"command","params":{"name":"model","args":"--refresh"}}
            {"method":"shutdown"}
            """), output, new StringWriter());
        Assert.Equal("chatgpt/account-model", runner.CurrentModel);
        var lines = output.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries);
        using var ready = JsonDocument.Parse(lines[0]);
        Assert.Contains(ready.RootElement.GetProperty("models").EnumerateArray(), m => m.GetProperty("id").GetString() == "chatgpt/account-model");
        using var refreshed = JsonDocument.Parse(lines[^1]);
        Assert.Equal("chatgpt/account-model", refreshed.RootElement.GetProperty("model").GetString());
        Assert.Equal(4, refreshed.RootElement.GetProperty("models").GetArrayLength());
    }

    [Fact]
    public async Task Rpc_RejectsBothSwitchMethodsDuringTurn()
    {
        var (llm, _, _, _) = Setup();
        var runner = new SlowRunner();
        using var host = new CliHost(runner, new InMemoryEventBus(), llm, [], new ReplOptions());
        using var output = new StringWriter();
        await RpcMode.RunAsync(host, new CliArgs { NoSession = true }, new StringReader("""
            {"method":"prompt","params":{"message":"hi"}}
            {"method":"set_model","params":{"model":"chatgpt/account-model"}}
            {"method":"command","params":{"name":"model","args":"chatgpt/account-model"}}
            {"method":"shutdown"}
            """), output, new StringWriter());
        Assert.Equal("deepseek-flash", runner.CurrentModel);
        Assert.Equal(2, output.ToString().Split('"').Count(s => s == "busy"));
    }

    [Fact]
    public void References_PreserveSlashesInsideOpaqueModelIds()
    {
        Assert.Equal(new ModelReference("chatgpt", "org/model"), ModelReference.Parse("chatgpt/org/model", "deepseek", ["chatgpt"]));
        Assert.Equal(new ModelReference("deepseek", "org/model"), ModelReference.Parse("org/model", "deepseek", ["chatgpt"]));
    }

    private sealed class Adapter(string provider, IReadOnlyList<ModelSpec> models) : ChatAdapter
    {
        public bool Configured { get; set; } = true;
        public int Refreshes { get; private set; }
        public GenerateOptions? LastRequest { get; private set; }
        public override IReadOnlyList<ModelSpec> Catalog => models;
        public override LlmProviderInfo ProviderInfo(string _) => new(provider, provider);
        public override Task<bool> CheckAuthAsync(string _, ILlmCredentialStore store, CancellationToken ct = default) => Task.FromResult(Configured);
        public override Task<IReadOnlyList<LlmModelInfo>> RefreshModelsAsync(string id, CancellationToken ct = default)
        { Refreshes++; return Task.FromResult(ListModels(id)); }
        public override async IAsyncEnumerable<StreamChunk> StreamAsync(GenerateOptions options, [EnumeratorCancellation] CancellationToken ct)
        {
            LastRequest = options;
            yield return new StreamChunk.TextDelta(0, "ok");
            yield return new StreamChunk.Finish(new FinishReason.Stop());
            await Task.CompletedTask;
        }
    }

    private sealed class SlowRunner : IAgentRunner
    {
        public string CurrentModel { get; set; } = "deepseek-flash";
        public IReadOnlyList<Core.Skills.Skill> ActiveSkills { get; set; } = [];
        public IInterruptSignal? InterruptSignal { get; set; }
        public void ResetHistory() { }
        public async Task<AgentResult> RunAsync(string userMessage, CancellationToken ct = default)
        {
            await Task.Delay(100, ct);
            return new AgentResult { Answer = "ok", Trajectory = [], Iterations = 1, StopReason = AgentStopReason.Answer };
        }
    }
}
