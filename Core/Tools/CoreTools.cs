using Core.AgentLoop;
using Core.Llm;

namespace Core.Tools;

/// <summary>
/// 八个内置核心编码工具（第五章 Coding Agent）的注册表与聚合入口，
/// 对应 pi 的 core/tools/index.ts：
/// <list type="bullet">
/// <item>工具名常量 + 工具集（all / coding / read-only）——可给不同场景暴露不同工具子集。</item>
/// <item>per-tool options（<see cref="Options"/>）——统一在注册层配置各工具的旋钮。</item>
/// <item>单工具路由 <see cref="CreateTool"/>（未知名字抛错）与组合工厂。</item>
/// </list>
/// Definitions（给模型的 ChatTool 列表）与 CreateExecutor（运行时执行器）共用同一注册表，
/// 保证 schema 与实现一致（bash/powershell 均为持久化会话模式）。
/// </summary>
public static class CoreTools
{
    // ---- 工具名（对应 pi 的 ToolName union）----

    public static class ToolNames
    {
        public const string ReadFile = "read_file";
        public const string WriteFile = "write_file";
        public const string EditFile = "edit_file";
        public const string Glob = "glob";
        public const string Grep = "grep";
        public const string Bash = "bash";
        public const string PowerShell = "powershell";
        public const string Python = "python";
    }

    /// <summary>全部内置工具名（对应 pi 的 allToolNames）。</summary>
    public static readonly IReadOnlySet<string> AllToolNames = new HashSet<string>(
        [ToolNames.ReadFile, ToolNames.WriteFile, ToolNames.EditFile, ToolNames.Glob, ToolNames.Grep, ToolNames.Bash, ToolNames.PowerShell, ToolNames.Python],
        StringComparer.Ordinal);

    /// <summary>可写工具集（能修改文件系统）——对应 pi 的 coding tools。</summary>
    public static readonly IReadOnlySet<string> CodingToolNames = new HashSet<string>(
        [ToolNames.ReadFile, ToolNames.WriteFile, ToolNames.EditFile, ToolNames.Bash], StringComparer.Ordinal);

    /// <summary>只读工具集（仅查看/搜索）——对应 pi 的 read-only tools。</summary>
    public static readonly IReadOnlySet<string> ReadOnlyToolNames = new HashSet<string>(
        [ToolNames.ReadFile, ToolNames.Glob, ToolNames.Grep], StringComparer.Ordinal);

    // ---- per-tool options（对应 pi 的 ToolsOptions）----

    public sealed class ReadFileOptions
    {
        /// <summary>单次读取的文件大小上限（默认 <see cref="ReadFileTool.MaxBytes"/>）。</summary>
        public long? MaxBytes { get; init; }
    }

    public sealed class GlobOptions
    {
        /// <summary>最多返回的匹配条数（默认 <see cref="GlobTool.MaxResults"/>）。</summary>
        public int? MaxResults { get; init; }
    }

    public sealed class GrepOptions
    {
        /// <summary>最多返回的匹配条数（默认 <see cref="GrepTool.MaxResults"/>）。</summary>
        public int? MaxResults { get; init; }

        /// <summary>跳过大于该字节数的文件（默认 <see cref="GrepTool.MaxFileBytes"/>）。</summary>
        public long? MaxFileBytes { get; init; }
    }

    public sealed class BashOptions
    {
        /// <summary>覆盖平台默认 shell。</summary>
        public ShellCommand? Shell { get; init; }

        /// <summary>覆盖默认超时（默认 30 秒）。</summary>
        public TimeSpan? Timeout { get; init; }
    }

    public sealed class PowerShellOptions
    {
        /// <summary>覆盖默认超时（默认 30 秒）。</summary>
        public TimeSpan? Timeout { get; init; }
    }

    public sealed class PythonOptions
    {
        /// <summary>python 解释器路径/命令（默认走 PATH 的 python）。</summary>
        public string? Executable { get; init; }

        /// <summary>沙盒工作目录（默认系统临时目录）。</summary>
        public string? SandboxDirectory { get; init; }

        /// <summary>覆盖默认超时（默认 30 秒）。</summary>
        public TimeSpan? Timeout { get; init; }
    }

    /// <summary>全部工具的可选配置；未设置的项用默认值。</summary>
    public sealed class Options
    {
        public ReadFileOptions? ReadFile { get; init; }
        public GlobOptions? Glob { get; init; }
        public GrepOptions? Grep { get; init; }
        public BashOptions? Bash { get; init; }
        public PowerShellOptions? PowerShell { get; init; }
        public PythonOptions? Python { get; init; }
    }

    // ---- 单工具路由（对应 pi 的 createTool：未知名字抛错）----

    /// <summary>按名字创建一个工具；未知名字抛 <see cref="InvalidOperationException"/>。</summary>
    public static ICoreTool CreateTool(string toolName, string baseDirectory, Options? options = null, ShellSession? session = null)
        => BuildTool(toolName, baseDirectory, options, session, powerShellSession: null);

    /// <summary>
    /// 内部路由：shell 类工具按各自会话挂接——bash 用默认 shell 会话，powershell 用 PowerShell 会话
    /// （-Command -，语法/编码与 cmd/sh 不同），两者不能共用同一个 <see cref="ShellSession"/>。
    /// </summary>
    private static ICoreTool BuildTool(string toolName, string baseDirectory, Options? options,
        ShellSession? session, ShellSession? powerShellSession)
        => toolName switch
        {
            ToolNames.ReadFile => new ReadFileTool(baseDirectory, options?.ReadFile?.MaxBytes),
            ToolNames.WriteFile => new WriteFileTool(baseDirectory),
            ToolNames.EditFile => new EditFileTool(baseDirectory),
            ToolNames.Glob => new GlobTool(baseDirectory, options?.Glob?.MaxResults),
            ToolNames.Grep => new GrepTool(baseDirectory, options?.Grep?.MaxResults, options?.Grep?.MaxFileBytes),
            ToolNames.Bash => new BashTool(baseDirectory, shell: options?.Bash?.Shell, timeout: options?.Bash?.Timeout, session: session),
            ToolNames.PowerShell => new PowerShellTool(baseDirectory, timeout: options?.PowerShell?.Timeout, session: powerShellSession),
            ToolNames.Python => new PythonTool(
                options?.Python?.Executable ?? "python",
                options?.Python?.SandboxDirectory,
                options?.Python?.Timeout),
            _ => throw new InvalidOperationException($"未知工具名: {toolName}"),
        };

    // ---- 工具集组合（对应 pi 的 createAllTools / createCodingTools / createReadOnlyTools）----

    /// <summary>工具集的规范顺序（Definitions 与 Executor 共用，保证顺序一致）。</summary>
    private static readonly string[] CanonicalOrder =
    [
        ToolNames.ReadFile, ToolNames.WriteFile, ToolNames.EditFile, ToolNames.Glob, ToolNames.Grep, ToolNames.Bash,
        ToolNames.PowerShell, ToolNames.Python,
    ];

    /// <summary>
    /// 创建指定工具集（默认全部）。<paramref name="session"/> 非空时 bash 为共享持久化会话模式、
    /// <paramref name="powerShellSession"/> 非空时 powershell 为共享持久化会话模式
    /// （cwd/环境变量跨调用保持）；为 null 时对应工具为一次性模式。
    /// </summary>
    public static IReadOnlyList<ICoreTool> CreateTools(
        string baseDirectory, Options? options = null, IReadOnlySet<string>? toolNames = null,
        ShellSession? session = null, ShellSession? powerShellSession = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(baseDirectory);
        var set = toolNames ?? AllToolNames;
        return CanonicalOrder.Where(set.Contains)
            .Select(name => BuildTool(name, baseDirectory, options, session, powerShellSession)).ToList();
    }

    /// <summary>可写工具集（read/write/edit/bash）。</summary>
    public static IReadOnlyList<ICoreTool> CreateCodingTools(string baseDirectory, Options? options = null, ShellSession? session = null)
        => CreateTools(baseDirectory, options, CodingToolNames, session);

    /// <summary>只读工具集（read/glob/grep）。</summary>
    public static IReadOnlyList<ICoreTool> CreateReadOnlyTools(string baseDirectory, Options? options = null, ShellSession? session = null)
        => CreateTools(baseDirectory, options, ReadOnlyToolNames, session);

    // ---- 定义（给模型）与执行器 ----

    /// <summary>
    /// 指定工具集的 ChatTool 定义（传给模型以允许发起工具调用）。
    /// bash/powershell 始终以共享持久化会话模式定义（与 <see cref="CreateExecutor"/> 一致）。
    /// 会话是惰性的（不执行命令不会拉起进程）；这里只需要 Schema，取完定义立即释放，不留孤儿会话。
    /// </summary>
    public static IReadOnlyList<ChatTool> Definitions(string baseDirectory, Options? options = null, IReadOnlySet<string>? toolNames = null)
    {
        using var session = new ShellSession(baseDirectory);
        using var powerShellSession = new ShellSession(baseDirectory, ShellCommand.PowerShellSession);
        return CreateTools(baseDirectory, options, toolNames, session, powerShellSession).Select(t => t.Definition).ToList();
    }

    /// <summary>可写工具集的定义。</summary>
    public static IReadOnlyList<ChatTool> CodingDefinitions(string baseDirectory, Options? options = null)
        => Definitions(baseDirectory, options, CodingToolNames);

    /// <summary>只读工具集的定义。</summary>
    public static IReadOnlyList<ChatTool> ReadOnlyDefinitions(string baseDirectory, Options? options = null)
        => Definitions(baseDirectory, options, ReadOnlyToolNames);

    /// <summary>
    /// 创建按工具名分发的执行器，供 ReAct 循环使用。
    /// bash 与 powershell 各挂接一个共享的持久化终端会话（惰性启动，第一次调用才拉起进程；
    /// 两者 shell 不同，不能共用一个会话）。
    /// 返回的执行器实现 IDisposable，用完后请释放以终止会话进程。
    /// </summary>
    public static Executor CreateExecutor(string baseDirectory, Options? options = null, IReadOnlySet<string>? toolNames = null)
    {
        var session = new ShellSession(baseDirectory);
        var powerShellSession = new ShellSession(baseDirectory, ShellCommand.PowerShellSession);
        return new Executor(
            CreateTools(baseDirectory, options, toolNames, session, powerShellSession), session, powerShellSession);
    }

    /// <summary>
    /// 工具使用说明：作为 stable_prefix 的一部分注入系统提示，让模型知道有哪八个工具、
    /// 观察结果长什么样、以及各类工具的使用惯例。
    /// </summary>
    public static string Instructions { get; } =
        """
        你是 Di 编程助手，可以在工作区中读取、编写、修改文件，并运行命令与代码。

        内置工具：
        1. read_file —— 读取文件，输出带行号。可用 start_line/end_line 只读某一段；不确定内容时先读再动，不要凭猜。
           输出超 2000 行/64KB 会被截断并提示"用 start_line=N 继续读取"——照提示续读，直到读完为止。
        2. write_file —— 整体覆盖写入一个文件（是覆盖，不是追加）。覆盖前若不确定文件现状，先用 read_file/glob 确认。
        3. edit_file —— 精准编辑：给出 old_string 与 new_string，把文件中唯一出现的 old_string 替换为 new_string。
           old_string 必须在文件中只出现一次（唯一），否则返回错误；报错时请提供更多上下文使其唯一。
           这是修改文件的推荐方式，比整体重写更安全。
        4. glob —— 按文件名模式（支持 * ? **）搜索文件，返回匹配的相对路径列表。结果超过上限时提示"用 limit=N 查看更多"。
        5. grep —— 按模式搜索文件内容，返回 file:行号: 内容（如 src/api.py:42: # TODO: ...）。
           可用 ignore_case 忽略大小写、literal 按普通文本匹配、context 显示上下文行、limit 调整结果上限；
           达上限时提示"用 limit=2N 查看更多"。定位代码逻辑用 grep，先搜再读，不要编造文件内容。
        6. bash —— 在共享的持久化终端会话中执行命令，返回退出码与合并输出（stdout+stderr）。
           cd、环境变量、激活的虚拟环境等状态在多次调用之间保持——切换目录用 cd 而不是 working_dir。
           适合跑测试、处理特殊格式文件、装依赖。超时默认 30 秒（可用 timeout 参数覆盖，单位秒），
           超时返回 error（会话自动重建），长输出自动截断头尾。
        7. powershell —— 在共享的持久化 PowerShell 会话中执行命令，返回退出码与合并输出（stdout+stderr）。
           cd、变量、环境变量等状态在多次调用之间保持——切换目录用 cd（Set-Location）而不是 working_dir。
           适合在 Windows 上跑 PowerShell 脚本（.ps1）、调用 .NET 对象/命令行工具。超时默认 30 秒
           （可用 timeout 参数覆盖，单位秒），超时返回 error（会话自动重建），长输出自动截断头尾。
        8. python —— 在沙盒临时目录中执行一段 Python 代码，适合计算、数据处理、生成图表。超时返回 error，长输出截断。

        使用惯例：
        - 观察结果以 "exit: N"（N 为退出码）或 "error: ..."（本次调用出错）开头。error 表示需要修正参数后重试。
        - 长输出会被截断（保留头尾）；必要时缩小搜索范围或分批读取。
        - 修改文件优先 edit_file（唯一性校验），整体重写才用 write_file。
        """;

    /// <summary>把 ToolCallBlock 按工具名分发给对应工具，未知工具返回错误观察。</summary>
    public sealed class Executor : IToolExecutor, IDisposable
    {
        private readonly IReadOnlyDictionary<string, ICoreTool> _tools;
        private readonly ShellSession? _session;
        private readonly ShellSession? _powerShellSession;

        public Executor(IEnumerable<ICoreTool> tools, ShellSession? session = null, ShellSession? powerShellSession = null)
        {
            _tools = tools.ToDictionary(t => t.Name);
            _session = session;
            _powerShellSession = powerShellSession;
        }

        public Task<string> ExecuteAsync(ToolCallBlock call, CancellationToken cancellationToken = default)
        {
            if (_tools.TryGetValue(call.Name, out var tool))
                return tool.ExecuteAsync(call.Arguments, cancellationToken);
            return Task.FromResult($"error: 未知工具 '{call.Name}'");
        }

        public void Dispose()
        {
            _session?.Dispose();
            _powerShellSession?.Dispose();
        }
    }
}
