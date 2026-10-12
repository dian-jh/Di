using System.Text.Json;
using Core.Llm;

namespace Core.Tools;

/// <summary>
/// PowerShell 工具：在 Windows PowerShell 会话中执行命令，对应 pi 的 powershell.ts（同一套 shell 逻辑）。
/// 与 <see cref="BashTool"/> 相同的双模式设计：
/// - 持久化会话模式（传入 <see cref="ShellSession"/>）：cd、变量、环境变量跨调用保持。
/// - 一次性模式（无会话）：每条命令起一个临时 PowerShell 会话（fresh 进程，可指定 working_dir），
///   用完即释放——不直接走 ProcessRunner 是因为 PS 5.1 一次性进程的错误走 CLIXML（<Objs ...>）到 stderr
///   且原生命令退出码不传播，会话路径天然规避这两点。
/// 编码：不经 [Console]::OutputEncoding，stdout 按 UTF-8 解码、stderr 按 OEM（引擎错误），中文两端无损。
/// </summary>
public sealed class PowerShellTool : ICoreTool
{
    public const int DefaultTimeoutSeconds = 30;

    /// <summary>单次调用可用 timeout 参数覆盖的超时上限（秒）。</summary>
    public const int MaxTimeoutSeconds = 3600;

    private readonly string _baseDirectory;
    private readonly TimeSpan _timeout;
    private readonly ShellSession? _session;

    public PowerShellTool(string baseDirectory, TimeSpan? timeout = null, ShellSession? session = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(baseDirectory);
        _baseDirectory = baseDirectory;
        _timeout = timeout ?? TimeSpan.FromSeconds(DefaultTimeoutSeconds);
        _session = session;
    }

    public string Name => "powershell";

    public ChatTool Definition => _session is not null
        ? ChatTool.Create("powershell",
            "在共享的持久化 PowerShell 会话中执行一条命令，返回退出码与合并后的输出（stdout + stderr）。cd、变量、环境变量等状态在多次调用之间保持——切换目录请用 cd（Set-Location），而不是 working_dir。命令超时（默认 30 秒，可用 timeout 参数覆盖，单位秒）会终止会话并在下次调用时自动重建。长输出自动截断头尾。",
            ToolHelpers.Schema(
                ("command", "string", "要在 PowerShell 中执行的命令"),
                ("timeout", "integer", $"可选：超时秒数（默认 {DefaultTimeoutSeconds}，最大 {MaxTimeoutSeconds}）")))
        : ChatTool.Create("powershell",
            "在 PowerShell 中执行一条命令，返回退出码与合并后的输出（stdout + stderr）。命令超时（默认 30 秒，可用 timeout 参数覆盖，单位秒）会被终止并返回 error。长输出自动截断头尾。",
            ToolHelpers.Schema(
                ("command", "string", "要在 PowerShell 中执行的命令"),
                ("timeout", "integer", $"可选：超时秒数（默认 {DefaultTimeoutSeconds}，最大 {MaxTimeoutSeconds}）"),
                ("working_dir", "string", "可选：工作目录（默认工作区根目录）")));

    public string PromptSnippet => "在共享持久化 PowerShell 会话中执行命令";

    public IReadOnlyList<string> PromptGuidelines =>
    [
        "powershell 是共享持久化会话：cd、变量、环境变量等状态跨调用保持，切换目录用 cd（Set-Location）而不是 working_dir",
        "超时（默认 30 秒，可 timeout 覆盖）会终止命令并返回 error，会话自动重建",
    ];

    public async Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        try
        {
            using var doc = JsonDocument.Parse(argumentsJson);
            if (!ToolHelpers.TryGetString(doc.RootElement, "command", out var command, out var error))
                return error!;

            // 可选 timeout（秒）：单条命令覆盖默认超时；上限见 MaxTimeoutSeconds。
            if (!ToolHelpers.TryGetOptionalInt(doc.RootElement, "timeout", out var timeoutArg, out var timeoutError))
                return timeoutError!;
            if (timeoutArg is not null && (timeoutArg.Value <= 0 || timeoutArg.Value > MaxTimeoutSeconds))
                return $"error: timeout 必须是 1 到 {MaxTimeoutSeconds} 之间的整数秒";
            var timeout = timeoutArg is null ? _timeout : TimeSpan.FromSeconds(timeoutArg.Value);

            if (_session is not null)
            {
                // 持久化模式：命令在共享会话中执行；cwd/环境变量跨调用保持，
                // working_dir 由会话状态决定（模型用 cd 切换），这里不做单独处理。
                var sessionResult = await _session.ExecuteAsync(command!, timeout, cancellationToken);
                return sessionResult.ToObservation();
            }

            // 一次性模式：临时会话（fresh 进程）承载命令，working_dir 在会话创建时指定。
            var workingDirArg = ToolHelpers.TryGetOptionalString(doc.RootElement, "working_dir");
            var workingDir = workingDirArg is null ? _baseDirectory : ToolHelpers.ResolvePath(_baseDirectory, workingDirArg);
            if (!Directory.Exists(workingDir))
                return $"error: 工作目录不存在: {workingDirArg}";

            using var oneShot = new ShellSession(workingDir, ShellCommand.PowerShellSession);
            var result = await oneShot.ExecuteAsync(command!, timeout, cancellationToken);
            return result.ToObservation();
        }
        catch (JsonException)
        {
            return "error: arguments 不是合法 JSON";
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException)
        {
            return $"error: 路径参数非法: {ex.Message}";
        }
    }
}
