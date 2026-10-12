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
/// 设计文档见 docs/modules/deepseek.md。
/// </summary>
internal sealed class DeepSeekAdapter : ChatAdapter
{
    private readonly HttpClient _http;
    private readonly string _baseUrl;
    private readonly DeepSeekAdapterConfig _config;

    private readonly Uri _chatCompletionsUri;

    public DeepSeekAdapter(HttpClient http, DeepSeekAdapterConfig config, string? baseUrl = null)
    {
        _http = http ?? throw new ArgumentNullException(nameof(http));
        _config = config ?? throw new ArgumentNullException(nameof(config));
        _baseUrl = baseUrl ?? DeepSeekDefaults.Endpoint;
        _chatCompletionsUri = new Uri(new Uri(_baseUrl, UriKind.Absolute), DeepSeekDefaults.ChatCompletionsPath);
    }

    public override LlmAuthDefinition Auth =>
        LlmAuthDefinition.EnvApiKey("DeepSeek API key", DeepSeekDefaults.ApiKeyEnvironmentVariable);

    /// <summary>解析顺序：配置段（appsettings "DeepSeek:ApiKey"）优先，其次环境变量 —— 都在<b>请求时</b>解析。</summary>
    public override Task<string?> ResolveApiKeyAsync(string provider, ILlmCredentialStore store, CancellationToken cancellationToken = default)
    {
        if (!string.IsNullOrWhiteSpace(_config.ApiKey))
            return Task.FromResult<string?>(_config.ApiKey);
        return store.ResolveApiKeyAsync(provider, [DeepSeekDefaults.ApiKeyEnvironmentVariable], cancellationToken);
    }

    public override IReadOnlyList<string> ProviderIds => [DeepSeekDefaults.ProviderId];

    public override LlmProviderInfo ProviderInfo(string provider) => new(DeepSeekDefaults.ProviderId, "DeepSeek");

    /// <summary>
    /// 模型目录（纯数据）：官方当前可用模型及其元数据/成本费率。
    /// 加模型 = 在这里加一条记录，引擎零改动（对应 Pi：模型是纯数据）。
    /// ⚠ 成本费率是占位值，需按官方最新定价核对后更新（数据，非代码）。
    /// </summary>
    public override IReadOnlyList<ModelSpec> Catalog { get; } =
    [
        new("deepseek-flash", "DeepSeek Flash (V4.1)",
            ContextWindow: 1_000_000,
            DefaultMaxTokens: 64 * 1024,
            ReasoningEfforts: DeepSeekReasoning.Efforts,
            Cost: new ModelCostRates(InputPerMillion: 0.28, OutputPerMillion: 0.42, CacheReadPerMillion: 0.07)),
        new("deepseek-v4-pro", "DeepSeek V4 Pro",
            ContextWindow: 1_000_000,
            DefaultMaxTokens: 64 * 1024,
            ReasoningEfforts: DeepSeekReasoning.Efforts,
            Cost: new ModelCostRates(InputPerMillion: 1.20, OutputPerMillion: 4.00, CacheReadPerMillion: 0.30)),
    ];

    public override Task<LlmResolvedModelInfo> ResolveModelAsync(string provider, string model, CancellationToken cancellationToken = default)
    {
        // 精确元数据从目录派生；推理强度是所有 DeepSeek 模型共有的，缺省档位来自配置。
        var spec = Catalog.FirstOrDefault(m => m.Id == model);
        return Task.FromResult(new LlmResolvedModelInfo(
            provider,
            model,
            spec?.Name ?? model,
            Context: spec?.ContextWindow is { } contextWindow ? new LlmModelContext(contextWindow) : null,
            DefaultMaxTokens: spec?.DefaultMaxTokens,
            Reasoning: new LlmModelReasoningInfo(DeepSeekReasoning.Efforts, _config.DefaultReasoningEffort)));
    }

    public override async IAsyncEnumerable<StreamChunk> StreamAsync(
        GenerateOptions options,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var wire = DeepSeekTranslator.ToWire(options);

        // 请求级鉴权：ApiKey 由宿主（LlmRuntime）在请求时解析后注入 options；直连适配器时兜底自校验。
        if (string.IsNullOrWhiteSpace(options.ApiKey))
            throw new LlmException("DeepSeek 未配置 API Key。", LlmErrorCodes.MissingCredential);
        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, _chatCompletionsUri)
        {
            Content = JsonContent.Create(wire, options: DeepSeekJson.Options),
        };
        httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ApiKey);
        httpRequest.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var response = await SendAsync(httpRequest, cancellationToken).ConfigureAwait(false);

        try
        {
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var reader = new StreamReader(stream, Encoding.UTF8);

            // SSE 分帧（DSH：eventsource-parser 的职责，这里是手写最小实现）。
            var sawDone = false;
            var responseIdEmitted = false;

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

                // 首个携带 id 的 chunk 上报响应标识（用于追溯/日志）。
                if (!responseIdEmitted && chunk.Id is { } responseId)
                {
                    responseIdEmitted = true;
                    yield return new StreamChunk.ResponseInfo(responseId);
                }

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
