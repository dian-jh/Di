using System.Text.Json;
using Core.Llm;

namespace Core.Tools;

/// <summary>
/// 通用 Shell 工具：在平台默认终端中执行命令（跑测试、处理特殊格式文件等）。
/// 向模型展示的名字随平台——Windows 为 "cmd"（cmd.exe 命令提示符）、其他平台为 "bash"
/// （见 <see cref="CoreTools.PlatformShellName"/>）；描述与操作规则同样平台感知，
/// 避免模型在 Windows 上发 Unix 命令（ls/tail/pwd → "不是内部或外部命令"）。
/// 支持两种模式：一次性独立进程（可指定 working_dir）与共享持久化终端会话（cwd/环境变量
/// 跨调用保持，经 <see cref="ShellSession"/> 交互）。超时强杀（含进程树）并返回结构化错误；
/// 输出经 <see cref="OutputBuffer"/> 有界累积，长输出自动截断头尾。
/// </summary>
public sealed class BashTool : ICoreTool
{
    public const int DefaultTimeoutSeconds = 30;

    /// <summary>单次调用可用 timeout 参数覆盖的超时上限（秒）。</summary>
    public const int MaxTimeoutSeconds = 3600;

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

    public string Name => CoreTools.PlatformShellName;

    /// <summary>平台默认 shell 的展示名（Windows: cmd / 其他: bash），用于描述与规则文本。</summary>
    private static string DisplayName => CoreTools.PlatformShellName;

    public ChatTool Definition => _session is not null
        ? ChatTool.Create(Name, SessionDescription, ToolHelpers.Schema(
            ("command", "string", "要执行的命令"),
            ("timeout", "integer", $"可选：超时秒数（默认 {DefaultTimeoutSeconds}，最大 {MaxTimeoutSeconds}）")))
        : ChatTool.Create(Name, OneShotDescription, ToolHelpers.Schema(
            ("command", "string", "要执行的命令"),
            ("timeout", "integer", $"可选：超时秒数（默认 {DefaultTimeoutSeconds}，最大 {MaxTimeoutSeconds}）"),
            ("working_dir", "string", "可选：工作目录（默认工作区根目录）")));

    /// <summary>共享持久化会话模式下的工具描述（含平台 shell 的适用命令提示）。</summary>
    private static string SessionDescription => OperatingSystem.IsWindows()
        ? "在共享的持久化 cmd.exe 会话（Windows 命令提示符）中执行一条命令（stdout + stderr 合并）。" +
          "cd、环境变量、激活的虚拟环境等状态在多次调用之间保持——切换目录请用 cd，而不是 working_dir。" +
          "注意这是 Windows cmd.exe 不是 bash：列目录用 dir、看文件用 type、搜文本用 findstr、看当前目录用 echo %CD%，" +
          "没有 ls/tail/head/pwd/grep；路径分隔符是反斜杠 \\。多行 Python 脚本请改用 python 工具。" +
          $"命令超时（默认 {DefaultTimeoutSeconds} 秒，可用 timeout 参数覆盖，单位秒）会终止会话并在下次调用时自动重建。长输出自动截断头尾。"
        : "在共享的持久化终端会话中执行一条命令（stdout + stderr 合并）。" +
          "cd、环境变量、激活的虚拟环境等状态在多次调用之间保持——切换目录请用 cd，而不是 working_dir。" +
          $"命令超时（默认 {DefaultTimeoutSeconds} 秒，可用 timeout 参数覆盖，单位秒）会终止会话并在下次调用时自动重建。长输出自动截断头尾。";

    /// <summary>一次性独立进程模式下的工具描述（含平台 shell 的适用命令提示）。</summary>
    private static string OneShotDescription => OperatingSystem.IsWindows()
        ? "在 Windows 命令提示符（cmd.exe）中执行一条命令，返回退出码与合并后的输出（stdout + stderr）。" +
          "cmd.exe 没有 ls/tail/head/pwd/grep 命令：列目录用 dir、看文件用 type、搜文本用 findstr、看当前目录用 echo %CD%。" +
          $"命令超时（默认 {DefaultTimeoutSeconds} 秒，可用 timeout 参数覆盖，单位秒）会被终止并返回 error。长输出自动截断头尾。"
        : "在 shell 中执行一条命令，返回退出码与合并后的输出（stdout + stderr）。" +
          $"命令超时（默认 {DefaultTimeoutSeconds} 秒，可用 timeout 参数覆盖，单位秒）会被终止并返回 error。长输出自动截断头尾。";

    public string PromptSnippet => OperatingSystem.IsWindows()
        ? "在共享持久化 cmd.exe 会话中执行命令"
        : "在共享持久化终端会话中执行命令";

    public IReadOnlyList<string> PromptGuidelines => OperatingSystem.IsWindows()
        ?
        [
            "cmd 是共享持久化会话：cd、环境变量、激活的虚拟环境等状态跨调用保持，切换目录用 cd 而不是 working_dir",
            "Windows cmd.exe 没有 ls/tail/head/pwd/grep：列目录用 dir、看文件用 type、搜文本用 findstr、看当前目录用 echo %CD%",
            "多行 Python / 复杂逻辑请改用 python 工具，不要在 cmd 里内联多行脚本",
            "超时（默认 30 秒，可 timeout 覆盖）会终止命令并返回 error，会话自动重建",
        ]
        :
        [
            "bash 是共享持久化会话：cd、环境变量、激活的虚拟环境等状态跨调用保持，切换目录用 cd 而不是 working_dir",
            "超时（默认 30 秒，可 timeout 覆盖）会终止命令并返回 error，会话自动重建",
        ];

    public async Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        try
        {
            using var doc = JsonDocument.Parse(argumentsJson);
            if (!ToolHelpers.TryGetString(doc.RootElement, "command", out var command, out var error))
                return error!;

            // 可选 timeout（秒）：单条命令覆盖默认超时，如"构建可能要 5 分钟"。上限见 MaxTimeoutSeconds。
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

            var workingDirArg = ToolHelpers.TryGetOptionalString(doc.RootElement, "working_dir");
            var workingDir = workingDirArg is null ? _baseDirectory : ToolHelpers.ResolvePath(_baseDirectory, workingDirArg);
            if (!Directory.Exists(workingDir))
                return $"error: 工作目录不存在: {workingDirArg}";

            // Windows 默认 shell（cmd.exe）必须手工构造 /d /s /c "命令"：
            // ArgumentList 会把命令里内嵌的引号转义成 \"，而 cmd 不认这种转义（反斜杠被原样输出）。
            // /s 让 cmd 无条件剥离首尾各一层引号，命令里的 " & | > 等特殊字符原样生效。
            if (OperatingSystem.IsWindows() && _shell.IsPlatformDefault)
            {
                var result = await ProcessRunner.RunAsync(_shell.FileName, [], workingDir, timeout, cancellationToken,
                    rawArguments: $"/d /s /c \"{command!}\"");
                return result.ToObservation();
            }

            var args = new List<string>(_shell.PrefixArguments) { command! };
            var unixResult = await ProcessRunner.RunAsync(_shell.FileName, args, workingDir, timeout, cancellationToken);
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
