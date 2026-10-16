using Core.AgentLoop;
using Core.Llm;

namespace Di.Cli;

/// <summary>Shared by /model, RPC and the model factory: resolve first, check local auth, then commit.</summary>
public sealed class ModelSelection(ILlmService llm, IAgentRunner runner, string defaultProvider = "deepseek", Action? onProviderChanged = null)
{
    public ModelReference Current => ModelReference.Parse(runner.CurrentModel, defaultProvider, ProviderIds());
    public IReadOnlyList<LlmModelInfo> List() => llm.ListModels();

    public async Task<IReadOnlyList<string>> RefreshAsync(CancellationToken ct = default)
    {
        var errors = new List<string>();
        foreach (var provider in llm.ListProviders())
        {
            try
            {
                if (await llm.CheckAuthAsync(provider.Id, ct)) await llm.RefreshModelsAsync(provider.Id, ct);
            }
            catch (Exception ex) when (ex is LlmException or HttpRequestException or IOException)
            { errors.Add($"{provider.Name}: {ex.Message}"); }
        }
        return errors;
    }

    public async Task<ModelReference> SelectAsync(string query, CancellationToken ct = default)
    {
        query = query.Trim();
        if (query.Length == 0) throw new ArgumentException("请指定模型。");
        var models = List();
        var exact = models.Where(m => Equal($"{m.Provider}/{m.Id}", query)).ToArray();
        if (exact.Length == 0) exact = models.Where(m => Equal(m.Id, query)).ToArray();
        ModelReference selected;
        if (exact.Length == 1) selected = new(exact[0].Provider, exact[0].Id);
        else if (exact.Length > 1) throw Ambiguous(exact);
        else
        {
            var reference = ModelReference.Parse(query, Current.Provider, ProviderIds());
            if (reference.Id != query) selected = reference; // explicit provider: allow IDs missing from an advisory catalog
            else
            {
                var matches = models.Where(m => m.Id.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                    m.Name.Contains(query, StringComparison.OrdinalIgnoreCase)).ToArray();
                if (matches.Length > 1) throw Ambiguous(matches);
                if (matches.Length == 0) throw new ArgumentException($"未找到模型 {query}。用 /model 查看目录，或用 provider/model 指定完整 ID。");
                selected = new(matches[0].Provider, matches[0].Id);
            }
        }
        if (!await llm.CheckAuthAsync(selected.Provider, ct))
            throw new LlmException($"{selected.Provider} 尚未配置凭据，请先登录或配置 API Key。", LlmErrorCodes.MissingCredential);
        var providerChanged = Current.Provider != selected.Provider;
        // Keep default-provider labels short while qualified references carry cross-provider routing.
        runner.CurrentModel = selected.Provider == defaultProvider ? selected.Id : selected.QualifiedId;
        if (providerChanged) onProviderChanged?.Invoke();
        return selected;
    }

    private IEnumerable<string> ProviderIds() => llm.ListProviders().Select(p => p.Id)
        .Concat(List().Select(m => m.Provider)).Append(defaultProvider).Distinct(StringComparer.OrdinalIgnoreCase);
    private static bool Equal(string a, string b) => a.Equals(b, StringComparison.OrdinalIgnoreCase);
    private static ArgumentException Ambiguous(IEnumerable<LlmModelInfo> matches) =>
        new("匹配到多个模型，请使用 provider/model：" + string.Join(", ", matches.Select(m => $"{m.Provider}/{m.Id}")));
}
