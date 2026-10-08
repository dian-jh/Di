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

    public BashTool(string baseDirectory, ShellCommand? shell = null, TimeSpan? timeout = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(baseDirectory);
        _baseDirectory = baseDirectory;
        _shell = shell ?? ShellCommand.Default;
        _timeout = timeout ?? TimeSpan.FromSeconds(DefaultTimeoutSeconds);
    }

    public string Name => "bash";

    public ChatTool Definition => ChatTool.Create("bash",
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

            var workingDirArg = ToolHelpers.TryGetOptionalString(doc.RootElement, "working_dir");
            var workingDir = workingDirArg is null ? _baseDirectory : ToolHelpers.ResolvePath(_baseDirectory, workingDirArg);
            if (!Directory.Exists(workingDir))
                return $"error: 工作目录不存在: {workingDirArg}";

            var args = new List<string>(_shell.PrefixArguments) { command! };
            var result = await ProcessRunner.RunAsync(_shell.FileName, args, workingDir, _timeout, cancellationToken);
            return result.ToObservation();
        }
        catch (JsonException)
        {
            return "error: arguments 不是合法 JSON";
        }
    }
}
