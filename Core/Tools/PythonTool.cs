using System.Text.Json;
using Core.Llm;

namespace Core.Tools;

/// <summary>
/// Code Interpreter 工具（python）：在隔离沙盒（默认临时目录）中执行一段 Python 代码。
/// 每次调用在独立进程中运行（MVP 的进程级隔离，见第五章），超时强杀并返回结构化错误，长输出自动截断。
/// </summary>
public sealed class PythonTool : ICoreTool
{
    public const int DefaultTimeoutSeconds = 30;

    private readonly string _pythonExecutable;
    private readonly string _sandboxDirectory;
    private readonly TimeSpan _timeout;

    public PythonTool(string pythonExecutable = "python", string? sandboxDirectory = null, TimeSpan? timeout = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pythonExecutable);
        _pythonExecutable = pythonExecutable;
        _sandboxDirectory = sandboxDirectory ?? Path.GetTempPath();
        _timeout = timeout ?? TimeSpan.FromSeconds(DefaultTimeoutSeconds);
    }

    public string Name => "python";

    public ChatTool Definition => ChatTool.Create("python",
        "执行一段 Python 代码，返回退出码与合并后的输出（stdout + stderr）。代码在沙盒临时目录中运行（进程级隔离）。超时（30 秒）会被终止并返回 error。长输出自动截断头尾。",
        ToolHelpers.Schema(
            ("code", "string", "要执行的 Python 代码"),
            ("working_dir", "string", "可选：工作目录（默认沙盒临时目录）")));

    public async Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        try
        {
            using var doc = JsonDocument.Parse(argumentsJson);
            if (!ToolHelpers.TryGetString(doc.RootElement, "code", out var code, out var error))
                return error!;

            var workingDirArg = ToolHelpers.TryGetOptionalString(doc.RootElement, "working_dir");
            var workingDir = workingDirArg is null ? _sandboxDirectory : ToolHelpers.ResolvePath(_sandboxDirectory, workingDirArg);
            if (!Directory.Exists(workingDir))
                return $"error: 工作目录不存在: {workingDirArg}";

            var result = await ProcessRunner.RunAsync(_pythonExecutable, ["-c", code!], workingDir, _timeout, cancellationToken);
            return result.ToObservation();
        }
        catch (JsonException)
        {
            return "error: arguments 不是合法 JSON";
        }
    }
}
