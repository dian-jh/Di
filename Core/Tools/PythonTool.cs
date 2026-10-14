using System.Text;
using System.Text.Json;
using Core.Llm;

namespace Core.Tools;

/// <summary>
/// Code Interpreter 工具（python）：在隔离沙盒（默认临时目录）中执行一段 Python 代码。
/// 每次调用在独立进程中运行（MVP 的进程级隔离，见第五章），超时强杀并返回结构化错误，长输出自动截断。
/// 进程 stdin 恒以 EOF 空管道启动（<c>redirectInput</c>）：代码读不到 di / 用户终端的 stdin，
/// 也避开"继承孤儿管道导致子进程启动卡死"这类环境问题（见 ProcessRunner）。
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

    public string PromptSnippet => "在沙盒临时目录中执行一段 Python 代码";

    public IReadOnlyList<string> PromptGuidelines =>
    [
        "超时返回 error，长输出自动截断",
    ];

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

            // python 的输出编码随环境漂移（PYTHONIOENCODING / PYTHONUTF8 / Python 版本都可能让它写 UTF-8
            // 而不是 ProcessEncoding 假设的 OEM 字节，中文系统实测即乱码）。这里强制两端对齐 UTF-8：
            // 子进程 stdout/stderr 写 UTF-8，父进程按 UTF-8 解码 —— 与机器 locale 无关，行为确定。
            var result = await ProcessRunner.RunAsync(_pythonExecutable, ["-c", code!], workingDir, _timeout, cancellationToken,
                outputEncoding: Encoding.UTF8,
                environment: new Dictionary<string, string> { ["PYTHONIOENCODING"] = "utf-8" },
                redirectInput: true);
            return result.ToObservation();
        }
        catch (JsonException)
        {
            return "error: arguments 不是合法 JSON";
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException)
        {
            // 非法路径字符（如 NUL）：路径解析会抛 ArgumentException。
            return $"error: 路径参数非法: {ex.Message}";
        }
    }
}
