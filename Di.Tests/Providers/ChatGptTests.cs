using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Core.Configuration;
using Core.Llm;
using Core.Providers.ChatGpt;

namespace Di.Tests.Providers;

public sealed class ChatGptTests
{
    [Fact]
    public async Task ConsumedCode_RetriesWithIssuedClient()
    {
        using var f = new OAuthFixture { CodeFailuresRemaining = 1 };
        await f.Auth.SignInAsync(f.Browser);
        Assert.Equal("oaiapp_test", f.Authorization!["client_id"]);
        Assert.False(f.Authorization.ContainsKey("agent_name_hint"));
    }

    [Fact]
    public async Task Registration_ReusesClientAndHostAndValidatesPkce()
    {
        using var f = new OAuthFixture();
        await f.Auth.SignInAsync(f.Browser);
        Assert.True((await f.Auth.StatusAsync()).PlanEnabled);
        Assert.Equal("dynamic_agent_client", f.Authorization!["client_id"]);
        Assert.Equal("Di", f.Authorization["agent_name_hint"]);
        Assert.Equal("oaiapp_test", f.LastGrant!["client_id"]);
        Assert.Equal(f.Authorization["redirect_uri"], f.LastGrant["redirect_uri"]);
        Assert.Equal(f.Authorization["code_challenge"], Encode(SHA256.HashData(Encoding.ASCII.GetBytes(f.LastGrant["code_verifier"]))));
        var host = f.Authorization["ext_agent_host_id"];
        await f.Auth.SignInAsync(f.Browser);
        Assert.Equal(host, f.Authorization["ext_agent_host_id"]);
        Assert.Equal("oaiapp_test", f.Authorization["client_id"]);
        Assert.True(f.Authorization.ContainsKey("id_token_hint"));
        Assert.False(f.Authorization.ContainsKey("agent_name_hint"));
    }

    [Fact]
    public async Task Callback_InvalidStateIsRejectedBeforeValidCallback()
    {
        using var f = new OAuthFixture { SendInvalidState = true };
        await f.Auth.SignInAsync(f.Browser);
        Assert.True(f.InvalidStateRejected);
    }

    [Fact]
    public async Task Callback_DeclineDoesNotExchangeCode()
    {
        using var f = new OAuthFixture { Deny = true };
        await Assert.ThrowsAsync<LlmException>(() => f.Auth.SignInAsync(f.Browser));
        Assert.Null(f.LastGrant);
        Assert.False((await f.Auth.StatusAsync()).SignedIn);
    }

    [Theory]
    [InlineData("")]
    [InlineData("dynamic_agent_client")]
    public async Task Callback_MissingIssuedClientDoesNotExchangeCode(string clientId)
    {
        using var f = new OAuthFixture { CallbackClientId = clientId };
        await Assert.ThrowsAsync<InvalidDataException>(() => f.Auth.SignInAsync(f.Browser));
        Assert.Null(f.LastGrant);
    }

    [Fact]
    public async Task Callback_ChangedClientPreservesConnection()
    {
        using var f = new OAuthFixture();
        await f.Auth.SignInAsync(f.Browser);
        f.CallbackClientId = "oaiapp_different";
        await Assert.ThrowsAsync<InvalidDataException>(() => f.Auth.SignInAsync(f.Browser));
        Assert.Equal("oaiapp_test", (await f.Auth.StatusAsync()).ClientId);
    }

    [Theory]
    [InlineData("access_token")]
    [InlineData("refresh_token")]
    [InlineData("scope")]
    [InlineData("id_token")]
    [InlineData("expires_in")]
    public async Task TokenContract_RejectsInvalidFields(string field)
    {
        using var f = new OAuthFixture { InvalidField = field };
        await Assert.ThrowsAsync<InvalidDataException>(() => f.Auth.SignInAsync(f.Browser));
        Assert.False((await f.Auth.StatusAsync()).SignedIn);
    }

    [Fact]
    public async Task TokenContract_RequiresPlanPermission()
    {
        using var f = new OAuthFixture { GrantPlan = false };
        await Assert.ThrowsAsync<InvalidDataException>(() => f.Auth.SignInAsync(f.Browser));
        Assert.Null(await f.Auth.AccessTokenAsync(default));
    }

    [Fact]
    public async Task AuthCheck_IsLocalAndDoesNotRefresh()
    {
        using var f = new OAuthFixture();
        var runtime = new LlmRuntime();
        runtime.RegisterAdapter(["chatgpt"], new ChatGptAdapter(f.Http, f.Auth));
        Assert.False(await runtime.CheckAuthAsync("chatgpt"));
        await f.Auth.SignInAsync(f.Browser);
        await f.ExpireAsync();
        Assert.True(await runtime.CheckAuthAsync("chatgpt"));
        Assert.Equal(0, f.RefreshCount);
    }

    [Fact]
    public async Task Refresh_RotatesOnceAcrossInstances()
    {
        using var f = new OAuthFixture();
        await f.Auth.SignInAsync(f.Browser);
        await f.ExpireAsync();
        var another = new ChatGptAuth(f.Http, new ChatGptCredentialStore(DiHome.Resolve(f.Directory)));
        var tokens = await Task.WhenAll(f.Auth.AccessTokenAsync(default), another.AccessTokenAsync(default));
        Assert.All(tokens, token => Assert.Equal("access-rotated", token));
        Assert.Equal(1, f.RefreshCount);
        Assert.Equal("oaiapp_test", f.LastGrant!["client_id"]);
        Assert.Equal("https://api.openai.com/v1", f.LastGrant["resource"]);
        Assert.False(f.LastGrant.ContainsKey("scope"));
        Assert.Equal("refresh-rotated", (await f.Store.ReadAsync(default)).Credential!.RefreshToken);
    }

    [Theory]
    [InlineData("invalid_grant", false)]
    [InlineData("refresh_token_reused", false)]
    [InlineData("server_error", true)]
    public async Task RefreshErrors_ClearOnlyTerminalCredentials(string code, bool retained)
    {
        using var f = new OAuthFixture();
        await f.Auth.SignInAsync(f.Browser);
        await f.ExpireAsync();
        f.RefreshError = code;
        if (retained) await Assert.ThrowsAsync<LlmException>(() => f.Auth.AccessTokenAsync(default));
        else Assert.Null(await f.Auth.AccessTokenAsync(default));
        Assert.Equal(retained, (await f.Auth.StatusAsync()).SignedIn);
        Assert.Equal("oaiapp_test", (await f.Auth.StatusAsync()).ClientId);
    }

    [Fact]
    public async Task Logout_RevokesAndRetainsRegistration()
    {
        using var f = new OAuthFixture();
        await f.Auth.SignInAsync(f.Browser);
        Assert.True(await f.Auth.SignOutAsync());
        Assert.Equal("refresh-initial", f.Revocation!["token"]);
        Assert.False((await f.Auth.StatusAsync()).SignedIn);
        await f.Auth.SignInAsync(f.Browser);
        Assert.Equal("oaiapp_test", f.Authorization!["client_id"]);
        Assert.False(f.Authorization.ContainsKey("id_token_hint"));
    }

    [Fact]
    public async Task Responses_ToolsUsageReasoningAndReplay()
    {
        using var fixture = new OAuthFixture();
        using var http = new HttpClient(new Handler(async request =>
        {
            Assert.Equal("https://api.openai.com/v1/responses", request.RequestUri!.AbsoluteUri);
            Assert.Equal("Bearer", request.Headers.Authorization!.Scheme);
            Assert.Equal("test-token", request.Headers.Authorization.Parameter);
            var body = await request.Content!.ReadFromJsonAsync<JsonObject>();
            Assert.False(body!["store"]!.GetValue<bool>());
            Assert.True(body["stream"]!.GetValue<bool>());
            Assert.Equal("developer", body["input"]![0]!["role"]!.GetValue<string>());
            Assert.Equal("namespace", body["tools"]![0]!["type"]!.GetValue<string>());
            return Sse(
                """{"type":"response.created","response":{"id":"resp_test"}}""",
                """{"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"Think"}""",
                """{"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_test","summary":[],"encrypted_content":"opaque"}}""",
                """{"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"Working"}""",
                """{"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","call_id":"call_1","namespace":"di","name":"shell","arguments":""}}""",
                """{"type":"response.function_call_arguments.delta","output_index":2,"delta":"{\"cmd\":"}""",
                """{"type":"response.function_call_arguments.delta","output_index":2,"delta":"\"pwd\"}"}""",
                """{"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":{"cached_tokens":60},"output_tokens_details":{"reasoning_tokens":10}}}}""");
        }));
        var adapter = new ChatGptAdapter(http, fixture.Auth);
        var options = Options() with { Messages = [ChatMessage.System("You are Di"), ChatMessage.User("work")],
            Tools = [ChatTool.Create("shell", "Run shell", new JsonObject { ["type"] = "object" })] };
        var chunks = await Collect(adapter.StreamAsync(options, default));
        Assert.IsType<FinishReason.ToolCalls>(Assert.IsType<StreamChunk.Finish>(chunks[^1]).Reason);
        var usage = Assert.Single(chunks.OfType<StreamChunk.Usage>()).Tokens;
        Assert.Equal(40, usage.InputTokens);
        Assert.Equal(60, usage.CacheReadTokens);
        Assert.Equal(10, usage.ReasoningTokens);
        var assembler = new ChatAssembler();
        foreach (var chunk in chunks) assembler.Add(chunk);
        var assistant = assembler.Build();
        Assert.Equal("{\"cmd\":\"pwd\"}", Assert.Single(assistant.ToolCalls).Arguments);
        Assert.Single(assistant.Content.OfType<OpaqueBlock>());
        var replay = ChatGptTranslator.Request(options with { Messages = [assistant, ChatMessage.Tool("call_1", "result")] });
        Assert.Equal("reasoning", replay["input"]![0]!["type"]!.GetValue<string>());
        Assert.Equal("function_call_output", replay["input"]!.AsArray()[^1]!["type"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("response.failed", "subscription_sharing_usage_limit_exceeded")]
    [InlineData("response.incomplete", "content_filter")]
    public async Task StreamFailures_AreNotReportedAsSuccess(string terminal, string code)
    {
        using var fixture = new OAuthFixture();
        var detail = terminal == "response.failed" ? $"\"error\":{{\"code\":\"{code}\",\"message\":\"failure\"}}" :
            $"\"incomplete_details\":{{\"reason\":\"{code}\"}}";
        using var http = new HttpClient(new Handler(_ => Task.FromResult(Sse($"{{\"type\":\"{terminal}\",\"response\":{{{detail}}}}}"))));
        var chunks = await Collect(new ChatGptAdapter(http, fixture.Auth).StreamAsync(Options(), default));
        Assert.Equal(code, Assert.IsType<FinishReason.Error>(Assert.IsType<StreamChunk.Finish>(chunks[^1]).Reason).Failure.Code);
    }

    [Fact]
    public async Task TruncatedStream_ThrowsInsteadOfCompleting()
    {
        using var fixture = new OAuthFixture();
        using var http = new HttpClient(new Handler(_ => Task.FromResult(Sse("""{"type":"response.output_text.delta","delta":"partial"}"""))));
        var ex = await Assert.ThrowsAsync<LlmException>(() => Collect(new ChatGptAdapter(http, fixture.Auth).StreamAsync(Options(), default)));
        Assert.Equal(LlmErrorCodes.Connection, ex.Code);
    }

    [Fact]
    public async Task AdmissionError_PreservesBodyStatusAndRequestId()
    {
        using var fixture = new OAuthFixture();
        using var http = new HttpClient(new Handler(_ =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("{\"detail\":\"region restriction\"}") };
            response.Headers.Add("x-request-id", "req_123");
            return Task.FromResult(response);
        }));
        var ex = await Assert.ThrowsAsync<LlmException>(() => Collect(new ChatGptAdapter(http, fixture.Auth).StreamAsync(Options(), default)));
        Assert.Equal(403, ex.Status);
        Assert.Contains("req_123", ex.Message);
        Assert.Contains("region restriction", ex.Message);
        Assert.False(ex.IsRetryable);
    }

    [Fact]
    public void UnsupportedSampling_IsRejectedLocally()
    {
        var ex = Assert.Throws<LlmException>(() => ChatGptTranslator.Request(Options() with { Temperature = 0.5 }));
        Assert.Equal(LlmErrorCodes.UnsupportedOption, ex.Code);
    }

    [Fact]
    public async Task Catalog_UsesAccountTokenAndServerOrder()
    {
        using var fixture = new OAuthFixture();
        await fixture.Auth.SignInAsync(fixture.Browser);
        using var http = new HttpClient(new Handler(request =>
        {
            Assert.Equal("access-initial", request.Headers.Authorization!.Parameter);
            Assert.Equal("/v1/models", request.RequestUri!.AbsolutePath);
            return Task.FromResult(Json(new JsonObject { ["models"] = new JsonArray(
                new JsonObject { ["slug"] = "z-model", ["display_name"] = "Z", ["visibility"] = "list" },
                new JsonObject { ["slug"] = "hidden", ["display_name"] = "Hidden", ["visibility"] = "hidden" },
                new JsonObject { ["slug"] = "a-model", ["display_name"] = "A", ["visibility"] = "list" }) }));
        }));
        var adapter = new ChatGptAdapter(http, fixture.Auth);
        Assert.Equal(new[] { "z-model", "a-model" }, (await adapter.RefreshModelsAsync()).Select(m => m.Id));
    }

    private static GenerateOptions Options() => new() { Provider = "chatgpt", Model = "account-model", ApiKey = "test-token", Messages = [ChatMessage.User("Hello")] };
    private static async Task<List<StreamChunk>> Collect(IAsyncEnumerable<StreamChunk> stream)
    {
        var chunks = new List<StreamChunk>();
        await foreach (var chunk in stream) chunks.Add(chunk);
        return chunks;
    }
    private static HttpResponseMessage Sse(params string[] events) => new(HttpStatusCode.OK)
    { Content = new StringContent(string.Join("", events.Select(e => "data: " + e + "\n\n")), Encoding.UTF8, "text/event-stream") };
    private static HttpResponseMessage Json(JsonObject value, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = JsonContent.Create(value) };
    private static string Encode(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => send(request);
    }

    private sealed class OAuthFixture : IDisposable
    {
        public string Directory { get; } = Path.Combine(Path.GetTempPath(), "di-chatgpt-" + Guid.NewGuid());
        public ChatGptCredentialStore Store { get; }
        public HttpClient Http { get; }
        public ChatGptAuth Auth { get; }
        public Dictionary<string, string>? Authorization { get; private set; }
        public Dictionary<string, string>? LastGrant { get; private set; }
        public Dictionary<string, string>? Revocation { get; private set; }
        public string? InvalidField { get; init; }
        public bool GrantPlan { get; init; } = true;
        public bool SendInvalidState { get; init; }
        public bool InvalidStateRejected { get; private set; }
        public bool Deny { get; init; }
        public string CallbackClientId { get; set; } = "oaiapp_test";
        public string? RefreshError { get; set; }
        public int RefreshCount { get; private set; }
        public int CodeFailuresRemaining { get; set; }
        public OAuthFixture()
        {
            Store = new ChatGptCredentialStore(DiHome.Resolve(Directory));
            Http = new HttpClient(new Handler(Respond));
            Auth = new ChatGptAuth(Http, Store);
        }
        public async Task Browser(Uri uri)
        {
            Authorization = Parse(uri.Query);
            var callback = Authorization["redirect_uri"] + "?state=" + Authorization["state"] +
                (Deny ? "&error=access_denied" : "&code=code_test&client_id=" + CallbackClientId);
            // Browser navigation must run concurrently with the callback listener loop.
            _ = Task.Run(async () =>
            {
                using var browser = new HttpClient();
                if (SendInvalidState)
                {
                    using var invalid = await browser.GetAsync(Authorization["redirect_uri"] + "?state=wrong&code=bad");
                    InvalidStateRejected = invalid.StatusCode == HttpStatusCode.BadRequest;
                }
                using var response = await browser.GetAsync(callback);
            });
            await Task.CompletedTask;
        }
        public async Task ExpireAsync()
        {
            await Store.UpdateAsync(data => { data.Credential!.ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(-1); return Task.CompletedTask; }, default);
        }
        private async Task<HttpResponseMessage> Respond(HttpRequestMessage request)
        {
            switch (request.RequestUri!.AbsolutePath)
            {
                case "/.well-known/openid-configuration":
                    return Json(new JsonObject { ["issuer"] = "https://auth.openai.com", ["authorization_endpoint"] = "https://auth.openai.com/api/accounts/authorize",
                        ["token_endpoint"] = "https://auth.openai.com/api/accounts/oauth/token", ["jwks_uri"] = "https://auth.openai.com/jwks",
                        ["revocation_endpoint"] = "https://auth.openai.com/revoke" });
                case "/revoke":
                    Revocation = Parse(await request.Content!.ReadAsStringAsync());
                    return new(HttpStatusCode.OK);
                case "/api/accounts/oauth/token":
                    LastGrant = Parse(await request.Content!.ReadAsStringAsync());
                    var refresh = LastGrant["grant_type"] == "refresh_token";
                    if (!refresh && CodeFailuresRemaining > 0)
                    {
                        CodeFailuresRemaining--;
                        return Json(new JsonObject { ["error"] = "invalid_grant" }, HttpStatusCode.BadRequest);
                    }
                    if (refresh)
                    {
                        RefreshCount++;
                        await Task.Delay(50);
                        if (RefreshError is not null) return Json(new JsonObject { ["error"] = RefreshError },
                            RefreshError == "server_error" ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.BadRequest);
                    }
                    var token = new JsonObject { ["access_token"] = refresh ? "access-rotated" : "access-initial",
                        ["refresh_token"] = refresh ? "refresh-rotated" : "refresh-initial", ["token_type"] = "Bearer", ["expires_in"] = 3600,
                        ["scope"] = "openid email offline_access resource.invoke" + (GrantPlan ? " chatgpt.tokens.use.direct" : ""),
                        ["id_token"] = "opaque-id-token" };
                    if (InvalidField is not null) token[InvalidField] = InvalidField == "expires_in" ? JsonValue.Create(0) : JsonValue.Create("");
                    return Json(token);
                default: throw new InvalidOperationException("Unexpected HTTP request.");
            }
        }
        public void Dispose()
        {
            Http.Dispose();
            if (System.IO.Directory.Exists(Directory)) System.IO.Directory.Delete(Directory, true);
        }
        private static Dictionary<string, string> Parse(string value) => value.TrimStart('?').Split('&').Select(p => p.Split('=', 2))
            .ToDictionary(p => Uri.UnescapeDataString(p[0]), p => Uri.UnescapeDataString(p[1].Replace('+', ' ')));
    }
}
