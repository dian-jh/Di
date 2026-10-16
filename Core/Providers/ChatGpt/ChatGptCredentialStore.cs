using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Nodes;
using Core.Configuration;

namespace Core.Providers.ChatGpt;

// Never expose tokens through record-generated ToString() or status output.
internal sealed class ChatGptCredential
{
    public string ClientId { get; set; } = "";
    public string? AccessToken { get; set; }
    public string? RefreshToken { get; set; }
    public string? IdToken { get; set; }
    public string[] Scopes { get; set; } = [];
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? EarliestRefreshAt { get; set; }

    [System.Text.Json.Serialization.JsonIgnore]
    public bool NeedsRefresh => ExpiresAt <= DateTimeOffset.UtcNow.AddMinutes(3) &&
        (EarliestRefreshAt is null || EarliestRefreshAt <= DateTimeOffset.UtcNow || ExpiresAt <= DateTimeOffset.UtcNow);

    public static ChatGptCredential FromToken(JsonObject token, string clientId, ChatGptCredential? previous = null)
    {
        var access = ChatGptAuth.TokenString(token, "access_token");
        var refresh = ChatGptAuth.TokenString(token, "refresh_token");
        if (token["expires_in"] is not JsonValue expiry || !expiry.TryGetValue<int>(out var seconds) || seconds <= 0)
            throw new InvalidDataException("Invalid OAuth token field: expires_in");
        var scopes = token["scope"] is null && previous is not null ? previous.Scopes :
            ChatGptAuth.TokenString(token, "scope").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (!scopes.Contains(ChatGptAuth.DirectScope))
            throw new InvalidDataException("ChatGPT grant did not include " + ChatGptAuth.DirectScope);
        if (token["token_type"] is not null && !string.Equals(ChatGptAuth.TokenString(token, "token_type"), "Bearer", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Unsupported OAuth token_type.");
        return new()
        {
            ClientId = clientId, AccessToken = access, RefreshToken = refresh, Scopes = scopes,
            IdToken = token["id_token"]?.GetValue<string>() ?? previous?.IdToken,
            ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(seconds),
            EarliestRefreshAt = token["earliest_refresh_at"] is JsonValue earliest && earliest.TryGetValue<long>(out var unix)
                ? DateTimeOffset.FromUnixTimeSeconds(unix) : null
        };
    }

    public void ClearTokens() { AccessToken = null; RefreshToken = null; IdToken = null; Scopes = []; }
}

internal sealed class ChatGptCredentials
{
    public string HostId { get; set; } = "urn:uuid:" + Guid.NewGuid();
    public ChatGptCredential? Credential { get; set; }
}

/// <summary>Atomic owner-only storage, with a process-wide file lock held across rotating refreshes.</summary>
public sealed class ChatGptCredentialStore
{
    private readonly string _directory;
    public ChatGptCredentialStore(DiHome home) => _directory = Path.Combine(home.RootDirectory, "auth", "chatgpt");

    private async Task<FileStream> LockAsync(CancellationToken ct)
    {
        if (OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(_directory);
            var security = new DirectorySecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User!,
                FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(_directory).SetAccessControl(security);
        }
        else
        {
            Directory.CreateDirectory(_directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            File.SetUnixFileMode(_directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMinutes(2));
        while (true)
        {
            timeout.Token.ThrowIfCancellationRequested();
            try { return new FileStream(Path.Combine(_directory, "session.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) { await Task.Delay(100, timeout.Token); }
        }
    }

    internal async Task<ChatGptCredentials> ReadAsync(CancellationToken ct)
    {
        await using var gate = await LockAsync(ct);
        return await ReadUnlockedAsync(ct);
    }

    /// <summary>The only write path; login, logout and rotating refresh share this transaction.</summary>
    internal async Task<ChatGptCredentials> UpdateAsync(Func<ChatGptCredentials, Task> change, CancellationToken ct)
    {
        await using var gate = await LockAsync(ct);
        var data = await ReadUnlockedAsync(ct);
        await change(data);
        await WriteAsync(data, ct);
        return data;
    }

    private async Task<ChatGptCredentials> ReadUnlockedAsync(CancellationToken ct)
    {
        var path = Path.Combine(_directory, "credentials.json");
        if (!File.Exists(path)) return new();
        await using var file = File.OpenRead(path);
        var json = await JsonNode.ParseAsync(file, cancellationToken: ct) ?? throw new InvalidDataException("Empty ChatGPT credentials.");
        var data = json.Deserialize<ChatGptCredentials>()!;
        // Preserve the previously active credential when upgrading from the first implementation.
        if (data.Credential is null && json["Accounts"] is JsonArray accounts)
            data.Credential = accounts.FirstOrDefault(a => a?["ClientId"]?.GetValue<string>() == json["ActiveClientId"]?.GetValue<string>())
                ?.Deserialize<ChatGptCredential>();
        return data;
    }

    private async Task WriteAsync(ChatGptCredentials credentials, CancellationToken ct)
    {
        var temp = Path.Combine(_directory, Guid.NewGuid() + ".tmp");
        try
        {
            var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
            if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            await using (var file = new FileStream(temp, options))
            {
                await JsonSerializer.SerializeAsync(file, credentials, cancellationToken: ct);
                await file.FlushAsync(ct);
                file.Flush(true);
            }
            File.Move(temp, Path.Combine(_directory, "credentials.json"), true);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
}
