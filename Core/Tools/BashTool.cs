using System.Text.Json;
using Core.Llm;

namespace Core.Tools;

/// <summary>
/// Bash Shell 工具：在终端中执行命令（跑测试、处理特殊格式文件等）。
/// 每次调用在独立进程中执行（MVP 阶段；持久化终端会话是后续迭代，见第五章）。
/// 超时会被强杀并返回结构化错误，长输出自动截断头部/尾部。
/// </summary>
public sealed class BashTool : ICoreTool
{
    public const int DefaultTimeoutSeconds = 30;

    private readonly string _baseDirectory;
    private readonly ShellCommand _shell;
    private readonly TimeSpan _timeout;
    private readonly ShellSession? _session;

    public BashTool(string baseDirectory, ShellCommand? shell = null, TimeSpan? timeout = null, ShellSession? session = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(baseDirectory);
        _baseDirectory = baseDirectory;
        _shell = shell ?? ShellCommand.Default;
        _timeout = timeout ?? TimeSpan.FromSeconds(DefaultTimeoutSeconds);
        _session = session;
    }

    public string Name => "bash";

    public ChatTool Definition => _session is not null
        ? ChatTool.Create("bash",
            "在共享的持久化终端会话中执行一条命令（stdout + stderr 合并）。cd、环境变量、激活的虚拟环境等状态在多次调用之间保持——切换目录请用 cd，而不是 working_dir。命令超时（30 秒）会终止会话并在下次调用时自动重建。长输出自动截断头尾。",
            ToolHelpers.Schema(
                ("command", "string", "要执行的命令")))
        : ChatTool.Create("bash",
            "在 shell 中执行一条命令，返回退出码与合并后的输出（stdout + stderr）。命令超时（30 秒）会被终止并返回 error。长输出自动截断头尾。",
            ToolHelpers.Schema(
                ("command", "string", "要执行的命令"),
                ("working_dir", "string", "可选：工作目录（默认工作区根目录）")));

    public async Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        try
        {
            using var doc = JsonDocument.Parse(argumentsJson);
            if (!ToolHelpers.TryGetString(doc.RootElement, "command", out var command, out var error))
                return error!;

            if (_session is not null)
            {
                // 持久化模式：命令在共享会话中执行；cwd/环境变量跨调用保持，
                // working_dir 由会话状态决定（模型用 cd 切换），这里不做单独处理。
                var sessionResult = await _session.ExecuteAsync(command!, _timeout, cancellationToken);
                return sessionResult.ToObservation();
            }

            var workingDirArg = ToolHelpers.TryGetOptionalString(doc.RootElement, "working_dir");
            var workingDir = workingDirArg is null ? _baseDirectory : ToolHelpers.ResolvePath(_baseDirectory, workingDirArg);
            if (!Directory.Exists(workingDir))
                return $"error: 工作目录不存在: {workingDirArg}";

            // Windows 默认 shell（cmd.exe）必须手工构造 /d /s /c "命令"：
            // ArgumentList 会把命令里内嵌的引号转义成 \"，而 cmd 不认这种转义（反斜杠被原样输出）。
            // /s 让 cmd 无条件剥离首尾各一层引号，命令里的 " & | > 等特殊字符原样生效。
            if (OperatingSystem.IsWindows() && _shell.IsPlatformDefault)
            {
                var result = await ProcessRunner.RunAsync(_shell.FileName, [], workingDir, _timeout, cancellationToken,
                    rawArguments: $"/d /s /c \"{command!}\"");
                return result.ToObservation();
            }

            var args = new List<string>(_shell.PrefixArguments) { command! };
            var unixResult = await ProcessRunner.RunAsync(_shell.FileName, args, workingDir, _timeout, cancellationToken);
            return unixResult.ToObservation();
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
