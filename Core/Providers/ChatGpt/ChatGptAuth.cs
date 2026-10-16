using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Core.Llm;

namespace Core.Providers.ChatGpt;

public sealed record ChatGptStatus(string? ClientId, bool SignedIn, bool PlanEnabled);

/// <summary>Token-only OAuth client: validate the grant without treating the ID token as user identity.</summary>
public sealed class ChatGptAuth(HttpClient http, ChatGptCredentialStore store)
{
    internal const string Resource = "https://api.openai.com/v1";
    internal const string DirectScope = "chatgpt.tokens.use.direct";
    private const string AuthorizeUrl = "https://auth.openai.com/api/accounts/authorize";
    private const string TokenUrl = "https://auth.openai.com/api/accounts/oauth/token";
    private const string Scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

    public async Task<ChatGptStatus> StatusAsync(CancellationToken ct = default)
    {
        var c = (await store.ReadAsync(ct)).Credential;
        return new(c?.ClientId, c?.AccessToken is not null, c?.Scopes.Contains(DirectScope) == true);
    }

    internal async Task<bool> CheckAsync(CancellationToken ct)
    {
        var c = (await store.ReadAsync(ct)).Credential;
        return c is not null && c.Scopes.Contains(DirectScope) &&
            ((c.AccessToken is not null && c.ExpiresAt > DateTimeOffset.UtcNow) || c.RefreshToken is not null);
    }

    public async Task SignInAsync(Func<Uri, Task> openBrowser, bool newRegistration = false,
        bool requestConsent = false, CancellationToken ct = default)
    {
        var saved = await store.UpdateAsync(_ => Task.CompletedTask, ct);
        var clientId = newRegistration ? null : saved.Credential?.ClientId;
        ChatGptCredential credential;
        for (var attempt = 0; ; attempt++)
        {
            var grant = await AuthorizeAsync(openBrowser, saved.HostId, clientId,
                newRegistration ? null : saved.Credential?.IdToken, requestConsent, ct);
            clientId = grant.ClientId;
            try
            {
                var token = await RequestTokenAsync(new()
                {
                    ["grant_type"] = "authorization_code", ["client_id"] = clientId,
                    ["code"] = grant.Code, ["code_verifier"] = grant.Verifier,
                    ["redirect_uri"] = grant.RedirectUri, ["resource"] = Resource
                }, ct);
                TokenString(token, "id_token"); // opaque: never decode profile or identity claims
                credential = ChatGptCredential.FromToken(token, clientId);
                break;
            }
            catch (LlmException ex) when (ex.Code == "invalid_grant" && attempt == 0)
            { /* Retry fresh PKCE using the issued client ID, without registering twice. */ }
        }
        await store.UpdateAsync(data => { data.Credential = credential; return Task.CompletedTask; }, ct);
    }

    internal async Task<string?> AccessTokenAsync(CancellationToken ct)
    {
        var saved = (await store.ReadAsync(ct)).Credential;
        if (saved is null || !saved.Scopes.Contains(DirectScope)) return null;
        if (!saved.NeedsRefresh) return saved.AccessToken;
        var data = await store.UpdateAsync(async state =>
        {
            var current = state.Credential;
            if (current is null || !current.NeedsRefresh || current.RefreshToken is null) return;
            try
            {
                var token = await RequestTokenAsync(new()
                {
                    ["grant_type"] = "refresh_token", ["client_id"] = current.ClientId,
                    ["refresh_token"] = current.RefreshToken, ["resource"] = Resource
                }, ct);
                state.Credential = ChatGptCredential.FromToken(token, current.ClientId, current);
            }
            catch (LlmException ex) when (ex.Code is "invalid_grant" or "invalid_refresh_token" or "token_expired"
                or "refresh_token_expired" or "refresh_token_invalidated" or "refresh_token_reused")
            { current.ClearTokens(); }
        }, ct);
        var result = data.Credential;
        return result is not null && result.ExpiresAt > DateTimeOffset.UtcNow && result.Scopes.Contains(DirectScope)
            ? result.AccessToken : null;
    }

    public async Task<bool> SignOutAsync(CancellationToken ct = default)
    {
        var confirmed = true;
        await store.UpdateAsync(async data =>
        {
            var c = data.Credential;
            if (c is null) return;
            if (c.RefreshToken is not null)
            {
                confirmed = false;
                try
                {
                    var discovery = await http.GetFromJsonAsync<JsonObject>("https://auth.openai.com/.well-known/openid-configuration", ct);
                    var endpoint = new Uri(TokenString(discovery!, "revocation_endpoint"));
                    if (endpoint.Scheme != "https" || endpoint.Host != "auth.openai.com" || !endpoint.IsDefaultPort)
                        throw new InvalidDataException("Unexpected revocation endpoint.");
                    for (var attempt = 0; attempt < 3; attempt++)
                    {
                        try
                        {
                            using var body = new FormUrlEncodedContent(new Dictionary<string, string>
                            { ["token"] = c.RefreshToken, ["token_type_hint"] = "refresh_token", ["client_id"] = c.ClientId });
                            using var response = await http.PostAsync(endpoint, body, ct);
                            if (response.StatusCode == HttpStatusCode.OK) { confirmed = true; break; }
                            if ((int)response.StatusCode < 500) break;
                        }
                        catch (HttpRequestException) { }
                        await Task.Delay(TimeSpan.FromSeconds(attempt + 1), ct);
                    }
                }
                catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or InvalidDataException) { }
            }
            c.ClearTokens(); // retain the issued registration for the next sign-in
        }, CancellationToken.None);
        return confirmed;
    }

    private sealed record Grant(string Code, string ClientId, string Verifier, string RedirectUri);

    private static async Task<Grant> AuthorizeAsync(Func<Uri, Task> openBrowser, string hostId,
        string? clientId, string? idToken, bool consent, CancellationToken ct)
    {
        var state = Random();
        var verifier = Random();
        var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        var redirect = $"http://127.0.0.1:{port}/auth/callback";
        using var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/auth/");
        listener.Start();
        var query = new Dictionary<string, string>
        {
            ["client_id"] = clientId ?? "dynamic_agent_client", ["ext_agent_host_id"] = hostId,
            ["response_type"] = "code", ["redirect_uri"] = redirect, ["scope"] = Scopes,
            ["resource"] = Resource, ["state"] = state, ["nonce"] = Random(),
            ["code_challenge_method"] = "S256", ["code_challenge"] = Encode(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)))
        };
        if (clientId is null) query["agent_name_hint"] = "Di";
        else if (idToken is not null) query["id_token_hint"] = idToken;
        if (consent) query["prompt"] = "consent";
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMinutes(5));
        await openBrowser(new Uri(AuthorizeUrl + "?" + string.Join("&", query.Select(p => Uri.EscapeDataString(p.Key) + "=" + Uri.EscapeDataString(p.Value)))));
        while (true)
        {
            var callback = await listener.GetContextAsync().WaitAsync(timeout.Token);
            var values = callback.Request.QueryString;
            var valid = callback.Request.Url?.AbsolutePath == "/auth/callback" && values["state"] == state;
            callback.Response.StatusCode = valid ? 200 : 400;
            callback.Response.ContentType = "text/plain; charset=utf-8";
            await callback.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(valid ? "Return to Di to finish sign-in." : "Invalid OAuth callback."), ct);
            callback.Response.Close();
            if (!valid) continue;
            if (values["error"] is not null) throw new LlmException("ChatGPT authorization was declined or failed.", "OAUTH_AUTHORIZATION_FAILED");
            var issued = values["client_id"] ?? clientId;
            if (string.IsNullOrWhiteSpace(issued) || issued == "dynamic_agent_client" || (clientId is not null && clientId != issued))
                throw new InvalidDataException("Invalid OAuth callback client_id.");
            if (string.IsNullOrWhiteSpace(values["code"])) throw new InvalidDataException("Missing OAuth callback code.");
            return new(values["code"]!, issued, verifier, redirect);
        }
    }

    private async Task<JsonObject> RequestTokenAsync(Dictionary<string, string> fields, CancellationToken ct)
    {
        try
        {
            using var body = new FormUrlEncodedContent(fields);
            using var response = await http.PostAsync(TokenUrl, body, ct);
            var token = await response.Content.ReadFromJsonAsync<JsonObject>(ct) ?? throw new InvalidDataException("Empty OAuth token response.");
            if (!response.IsSuccessStatusCode)
            {
                var code = TokenString(token, "error");
                throw new LlmException("ChatGPT token exchange failed: " + code, code, (int)response.StatusCode);
            }
            return token;
        }
        catch (HttpRequestException ex) { throw new LlmException("Cannot reach OpenAI token endpoint.", LlmErrorCodes.Connection, inner: ex); }
        catch (JsonException ex) { throw new LlmException("Invalid OpenAI token response.", LlmErrorCodes.BadResponse, inner: ex); }
        catch (OperationCanceledException ex) when (!ct.IsCancellationRequested)
        { throw new LlmException("OpenAI token endpoint timed out.", LlmErrorCodes.Timeout, inner: ex); }
    }

    internal static string TokenString(JsonObject token, string field) =>
        token[field] is JsonValue value && value.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text)
            ? text : throw new InvalidDataException("Invalid OAuth token field: " + field);

    public static Task OpenSystemBrowserAsync(Uri uri)
    {
        Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        return Task.CompletedTask;
    }
    private static string Random() => Encode(RandomNumberGenerator.GetBytes(32));
    private static string Encode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
