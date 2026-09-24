using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Core.Llm;

namespace Core.Providers.DeepSeek;

/// <summary>
/// DeepSeek 的 <see cref="ChatAdapter"/> 实现（对应 DSH 的 llm-deepseek 适配器）。
///
/// 职责：
/// <list type="bullet">
/// <item>把 <see cref="GenerateOptions"/> 翻译成 DeepSeek 线格式（DeepSeekTranslator）。</item>
/// <item>发 HTTP、解析 SSE、把每个 chunk 归一化成 <see cref="StreamChunk"/>（遵守协议义务）。</item>
/// <item>把传输/协议故障抛成 <see cref="LlmException"/>；提供方带内故障以 Finish(Error/Aborted) 结束流。</item>
/// </list>
/// 鉴权头与 baseUrl 都放在<b>请求级</b>，不写进 HttpClient 的全局头 —— 多个 provider 可安全共享一个 HttpClient。
/// </summary>
internal sealed class DeepSeekAdapter : ChatAdapter
{
    private readonly HttpClient _http;
    private readonly string _apiKey;
    private readonly string _baseUrl;
    private readonly DeepSeekAdapterConfig _config;

    private readonly Uri _chatCompletionsUri;

    public DeepSeekAdapter(HttpClient http, string apiKey, DeepSeekAdapterConfig config, string? baseUrl = null)
    {
        _http = http ?? throw new ArgumentNullException(nameof(http));
        _apiKey = apiKey ?? throw new ArgumentNullException(nameof(apiKey));
        _config = config;
        _baseUrl = baseUrl ?? DeepSeekDefaults.Endpoint;
        _chatCompletionsUri = new Uri(new Uri(_baseUrl, UriKind.Absolute), DeepSeekDefaults.ChatCompletionsPath);
    }

    public override LlmProviderInfo ProviderInfo(string provider) => new(DeepSeekDefaults.ProviderId, "DeepSeek");

    public override Task<IReadOnlyList<LlmModelInfo>> ListModelsAsync(string provider, CancellationToken cancellationToken = default)
    {
        // 官方当前可用模型（2026-04）。
        IReadOnlyList<LlmModelInfo> models =
        [
            new(provider, "deepseek-flash", "DeepSeek Flash (V4.1)"),
            new(provider, "deepseek-v4-pro", "DeepSeek V4 Pro"),
        ];
        return Task.FromResult(models);
    }

    public override Task<LlmResolvedModelInfo> ResolveModelAsync(string provider, string model, CancellationToken cancellationToken = default)
    {
        var (contextWindow, defaultMaxTokens, efforts) = model switch
        {
            "deepseek-flash" => (1_000_000, 64 * 1024, DeepSeekReasoning.Efforts),
            "deepseek-v4-pro" => (1_000_000, 64 * 1024, DeepSeekReasoning.Efforts),
            _ => (null as int?, null as int?, DeepSeekReasoning.Efforts),
        };

        return Task.FromResult(new LlmResolvedModelInfo(
            provider,
            model,
            model,
            Context: contextWindow is null ? null : new LlmModelContext(contextWindow.Value),
            DefaultMaxTokens: defaultMaxTokens,
            Reasoning: new LlmModelReasoningInfo(efforts, _config.DefaultReasoningEffort)));
    }

    public override async IAsyncEnumerable<StreamChunk> StreamAsync(
        GenerateOptions options,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var wire = DeepSeekTranslator.ToWire(options);

        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, _chatCompletionsUri)
        {
            Content = JsonContent.Create(wire, options: DeepSeekJson.Options),
        };
        httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
        httpRequest.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var response = await SendAsync(httpRequest, cancellationToken).ConfigureAwait(false);

        try
        {
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var reader = new StreamReader(stream, Encoding.UTF8);

            // SSE 分帧（DSH：eventsource-parser 的职责，这里是手写最小实现）。
            var sawDone = false;

            while (true)
            {
                var line = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
                if (line is null)
                    break;

                if (!line.StartsWith("data:", StringComparison.Ordinal))
                    continue;

                var payload = line["data:".Length..].Trim();
                if (payload.Length == 0)
                    continue;

                if (payload == "[DONE]")
                {
                    sawDone = true;
                    break;
                }

                DeepSeekChatChunk? chunk;
                try
                {
                    chunk = JsonSerializer.Deserialize<DeepSeekChatChunk>(payload, DeepSeekJson.Options);
                }
                catch (JsonException)
                {
                    continue;   // 坏 chunk 跳过，不让整个流崩掉
                }

                if (chunk is null)
                    continue;

                foreach (var evt in TranslateChunk(chunk))
                    yield return evt;
            }

            // 正常用 [DONE] 收尾时，不发多余的错误 finish。
            if (!sawDone)
                yield return new StreamChunk.Finish(new FinishReason.Error(new LlmFailure(
                    "流式响应在没有 [DONE] 标记的情况下结束。", "STREAM_TRUNCATED", Status: 0)));
        }
        finally
        {
            response.Dispose();
        }
    }

    /// <summary>把一个 chunk 归一化成 0~N 个 <see cref="StreamChunk"/>。</summary>
    private static IEnumerable<StreamChunk> TranslateChunk(DeepSeekChatChunk chunk)
    {
        if (chunk.Usage is { } usage)
        {
            yield return new StreamChunk.Usage(DeepSeekTranslator.ToUsage(usage));
        }

        if (chunk.Choices is not { Count: > 0 })
            yield break;

        var choice = chunk.Choices[0];

        if (choice.Delta is not { } delta)
        {
            // 无 delta 但有 finish_reason：收口
            if (!string.IsNullOrEmpty(choice.FinishReason))
                yield return new StreamChunk.Finish(DeepSeekTranslator.FromFinishReason(choice.FinishReason));
            yield break;
        }

        if (!string.IsNullOrEmpty(delta.ReasoningContent))
            yield return new StreamChunk.ReasoningDelta(0, delta.ReasoningContent!);

        if (!string.IsNullOrEmpty(delta.Content))
            yield return new StreamChunk.TextDelta(0, delta.Content!);

        if (delta.ToolCalls is { Count: > 0 })
        {
            foreach (var call in delta.ToolCalls)
            {
                // 用线格式里 tool_calls[].index 作为合并键：同一次调用的参数碎片跨 chunk 到达。
                yield return new StreamChunk.ToolCallDelta(
                    call.Index ?? 0,
                    call.Id ?? string.Empty,
                    call.Function?.Name,
                    call.Function?.Arguments ?? string.Empty);
            }
        }

        if (!string.IsNullOrEmpty(choice.FinishReason))
        {
            yield return new StreamChunk.Finish(DeepSeekTranslator.FromFinishReason(choice.FinishReason));
        }
    }

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        try
        {
            var response = await _http
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
                .ConfigureAwait(false);

            if (response.IsSuccessStatusCode)
                return response;

            // 非 2xx：翻译成可编程异常（传输/协议故障路径）。
            var body = await SafeReadBodyAsync(response, cancellationToken).ConfigureAwait(false);
            var (message, code, status) = ParseDeepSeekError(body, (int)response.StatusCode);
            var retryAfter = response.Headers.RetryAfter?.Delta;
            response.Dispose();

            throw new LlmException(
                $"DeepSeek 接口调用失败：{message}",
                code,
                status,
                retryAfter);
        }
        catch (LlmException)
        {
            throw;
        }
        catch (HttpRequestException ex)
        {
            throw new LlmException($"无法连接 DeepSeek：{ex.Message}", LlmErrorCodes.Connection, inner: ex);
        }
        catch (OperationCanceledException ex) when (!cancellationToken.IsCancellationRequested)
        {
            throw new LlmException($"DeepSeek 请求超时（HttpClient.Timeout={_http.Timeout}）。", LlmErrorCodes.Timeout, inner: ex);
        }
    }

    private static async Task<string?> SafeReadBodyAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        try
        {
            return await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or ObjectDisposedException or OperationCanceledException)
        {
            return null;
        }
    }

    private static (string Message, string Code, int? Status) ParseDeepSeekError(string? body, int status)
    {
        if (!string.IsNullOrWhiteSpace(body))
        {
            try
            {
                using var document = JsonDocument.Parse(body);
                if (document.RootElement.TryGetProperty("error", out var error))
                {
                    var message = error.TryGetProperty("message", out var m) ? m.GetString() : null;
                    var type = error.TryGetProperty("type", out var t) ? t.GetString() : null;
                    var code = error.TryGetProperty("code", out var c) ? c.GetString() : null;

                    return (
                        message ?? type ?? body.Trim(),
                        MapErrorCode(code, type, status),
                        status);
                }
            }
            catch (JsonException)
            {
                // fall through
            }
        }

        return (body?.Trim() ?? $"{status}", MapErrorCode(null, null, status), status);
    }

    private static string MapErrorCode(string? code, string? type, int status) =>
        status == 429 ? LlmErrorCodes.RateLimited
        : status is 401 or 403 ? LlmErrorCodes.MissingCredential
        : code ?? type ?? LlmErrorCodes.InvalidRequest;
}

/// <summary>DeepSeek 适配器的推理强度（适配器拥有的不透明 ID）。</summary>
internal static class DeepSeekReasoning
{
    public static readonly IReadOnlyList<ReasoningEffort> Efforts =
    [
        new("off", "关闭思考"),
        new("low", "低强度"),
        new("high", "高强度"),
        new("max", "最大强度"),
    ];
}
