using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Core.Llm;

namespace Core.Providers.ChatGpt;

public sealed class ChatGptAdapter(HttpClient http, ChatGptAuth auth) : ChatAdapter
{
    public override IReadOnlyList<string> ProviderIds => ["chatgpt"];
    public override LlmProviderInfo ProviderInfo(string provider) => new("chatgpt", "ChatGPT");
    public override LlmAuthDefinition Auth => new LlmAuthDefinition.OAuth("Continue with ChatGPT");
    private IReadOnlyList<LlmModelInfo> _models = [];
    public override Task<bool> CheckAuthAsync(string provider, ILlmCredentialStore store, CancellationToken cancellationToken = default)
        => auth.CheckAsync(cancellationToken);
    public override Task<IReadOnlyList<LlmModelInfo>> RefreshModelsAsync(string provider, CancellationToken cancellationToken = default)
        => RefreshModelsAsync(cancellationToken);
    public override IReadOnlyList<LlmModelInfo> ListModels(string provider) => Volatile.Read(ref _models);
    public override Task<string?> ResolveApiKeyAsync(string provider, ILlmCredentialStore store, CancellationToken cancellationToken = default)
        => auth.AccessTokenAsync(cancellationToken);

    /// <summary>Fetch the active account's catalog. No guessed model IDs or subscription prices.</summary>
    public async Task<IReadOnlyList<LlmModelInfo>> RefreshModelsAsync(CancellationToken ct = default)
    {
        var token = await auth.AccessTokenAsync(ct) ?? throw new LlmException("Run di auth chatgpt login.", LlmErrorCodes.MissingCredential);
        using var request = new HttpRequestMessage(HttpMethod.Get, ChatGptAuth.Resource + "/models");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await SendAsync(request, ct);
        var body = await response.Content.ReadFromJsonAsync<JsonObject>(ct);
        var models = body?["models"]?.AsArray().OfType<JsonObject>()
            .Where(m => m["visibility"]?.GetValue<string>() == "list")
            .Select(m => new LlmModelInfo("chatgpt", m["slug"]!.GetValue<string>(), m["display_name"]!.GetValue<string>())).ToArray()
            ?? throw new LlmException("Missing ChatGPT models catalog.", LlmErrorCodes.BadResponse);
        Volatile.Write(ref _models, models);
        return models;
    }

    public override async IAsyncEnumerable<StreamChunk> StreamAsync(GenerateOptions options,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var body = ChatGptTranslator.Request(options);
        var token = options.ApiKey ?? await auth.AccessTokenAsync(cancellationToken)
            ?? throw new LlmException("Run di auth chatgpt login and enable ChatGPT plan usage.", LlmErrorCodes.MissingCredential);
        using var request = new HttpRequestMessage(HttpMethod.Post, ChatGptAuth.Resource + "/responses") { Content = JsonContent.Create(body) };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        using var response = await SendAsync(request, cancellationToken);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);
        var data = new StringBuilder();
        var blocks = new Dictionary<string, int>();
        var calls = new Dictionary<int, (string Id, string Name)>();
        var toolCalls = false;
        var finished = false;
        using var idle = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        while (true)
        {
            string? line;
            try
            {
                idle.CancelAfter(TimeSpan.FromMinutes(5));
                line = await reader.ReadLineAsync(idle.Token);
            }
            catch (OperationCanceledException ex) when (!cancellationToken.IsCancellationRequested)
            { throw new LlmException("ChatGPT stream idle timeout.", LlmErrorCodes.Timeout, inner: ex); }
            catch (Exception ex) when (ex is IOException or HttpRequestException)
            { throw new LlmException("ChatGPT stream interrupted.", LlmErrorCodes.Connection, inner: ex); }
            if (line is not null && line.StartsWith("data:", StringComparison.Ordinal))
            {
                data.AppendLine(line[5..].TrimStart());
                continue;
            }
            if (line is not null && line.Length != 0) continue;
            if (data.Length == 0) { if (line is null) break; continue; }
            var payload = data.ToString().Trim();
            data.Clear();
            if (payload == "[DONE]") break;
            JsonObject evt;
            try { evt = JsonNode.Parse(payload)!.AsObject(); }
            catch (JsonException ex) { throw new LlmException("Malformed ChatGPT SSE event.", LlmErrorCodes.BadResponse, inner: ex); }
            var type = evt["type"]?.GetValue<string>();
            var outputIndex = evt["output_index"]?.GetValue<int>() ?? 0;
            int Index(string key)
            {
                if (!blocks.TryGetValue(key, out var index)) blocks[key] = index = blocks.Count;
                return index;
            }
            switch (type)
            {
                case "response.created":
                    yield return new StreamChunk.ResponseInfo(evt["response"]?["id"]?.GetValue<string>());
                    break;
                case "response.output_text.delta":
                case "response.refusal.delta":
                    yield return new StreamChunk.TextDelta(Index($"text:{outputIndex}:{evt["content_index"]}"), evt["delta"]!.GetValue<string>());
                    break;
                case "response.reasoning_summary_text.delta":
                    yield return new StreamChunk.ReasoningDelta(Index($"reasoning:{outputIndex}"), evt["delta"]!.GetValue<string>());
                    break;
                case "response.output_item.added" when (evt["item"]?["type"]?.GetValue<string>() == "function_call"):
                    var item = evt["item"]!;
                    var id = item["call_id"]!.GetValue<string>();
                    var name = item["name"]!.GetValue<string>();
                    calls[outputIndex] = (id, name);
                    toolCalls = true;
                    yield return new StreamChunk.ToolCallDelta(Index($"call:{outputIndex}"), id, name, item["arguments"]?.GetValue<string>() ?? "");
                    break;
                case "response.function_call_arguments.delta":
                    if (!calls.TryGetValue(outputIndex, out var call)) throw new LlmException("Tool arguments arrived before function call.", LlmErrorCodes.BadResponse);
                    yield return new StreamChunk.ToolCallDelta(Index($"call:{outputIndex}"), call.Id, call.Name, evt["delta"]!.GetValue<string>());
                    break;
                case "response.output_item.done" when (evt["item"]?["type"]?.GetValue<string>() == "reasoning"):
                    yield return new StreamChunk.BlockEnd(Index($"reasoning:{outputIndex}"), new OpaqueBlock("chatgpt.reasoning", evt["item"]!.ToJsonString()));
                    break;
                case "response.completed":
                case "response.failed":
                case "response.incomplete":
                    var result = evt["response"]!.AsObject();
                    if (result["usage"] is JsonObject usage)
                    {
                        var cached = usage["input_tokens_details"]?["cached_tokens"]?.GetValue<int>() ?? 0;
                        yield return new StreamChunk.Usage(new TokenUsage(
                            (usage["input_tokens"]?.GetValue<int>() ?? 0) - cached,
                            usage["output_tokens"]?.GetValue<int>() ?? 0, usage["total_tokens"]?.GetValue<int>(), cached,
                            ReasoningTokens: usage["output_tokens_details"]?["reasoning_tokens"]?.GetValue<int>()));
                    }
                    FinishReason finish = type switch
                    {
                        "response.failed" => new FinishReason.Error(Failure(result["error"])),
                        "response.incomplete" when result["incomplete_details"]?["reason"]?.GetValue<string>() == "max_output_tokens" => new FinishReason.MaxTokens(),
                        "response.incomplete" => new FinishReason.Error(Failure(result["incomplete_details"])),
                        _ => toolCalls ? new FinishReason.ToolCalls() : new FinishReason.Stop()
                    };
                    finished = true;
                    yield return new StreamChunk.Finish(finish);
                    break;
                case "error":
                    finished = true;
                    yield return new StreamChunk.Finish(new FinishReason.Error(Failure(evt)));
                    break;
            }
            if (finished) yield break;
            if (line is null) break;
        }
        throw new LlmException("ChatGPT stream ended before a terminal Responses event.", LlmErrorCodes.Connection);
    }

    private static LlmFailure Failure(JsonNode? error) => new(error?["message"]?.GetValue<string>() ?? error?.ToJsonString() ?? "ChatGPT response failed.",
        error?["code"]?.GetValue<string>() ?? error?["reason"]?.GetValue<string>() ?? LlmErrorCodes.BadResponse);

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMinutes(2));
        HttpResponseMessage response;
        try { response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token); }
        catch (HttpRequestException ex) { throw new LlmException("Cannot connect to OpenAI.", LlmErrorCodes.Connection, inner: ex); }
        catch (OperationCanceledException ex) when (!ct.IsCancellationRequested)
        { throw new LlmException("OpenAI response headers timed out.", LlmErrorCodes.Timeout, inner: ex); }
        if (response.IsSuccessStatusCode) return response;
        using (response)
        {
            var body = await response.Content.ReadAsStringAsync(timeout.Token);
            var code = LlmErrorCodes.InvalidRequest;
            try { code = JsonNode.Parse(body)?["error"]?["code"]?.GetValue<string>() ?? code; }
            catch (JsonException) { }
            var requestId = response.Headers.TryGetValues("x-request-id", out var ids) ? string.Join(",", ids) : "unknown";
            throw new LlmException($"OpenAI HTTP {(int)response.StatusCode}, request_id={requestId}: {body}", code,
                (int)response.StatusCode, response.Headers.RetryAfter?.Delta);
        }
    }
}
