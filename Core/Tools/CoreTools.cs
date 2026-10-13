using System.Text;
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
/// 设计文档见 docs/modules/tools.md。
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

        /// <summary>
        /// 通用 shell 工具的<b>内部注册键</b>（工具集 / 路由用）。
        /// 向模型展示的名字是 <see cref="PlatformShellName"/>（Windows 为 "cmd"，其他平台为 "bash"），
        /// 两者不同名，因此 Executor 额外保留 "bash" 兼容别名（旧提示词 / 旧 skill 仍可调用）。
        /// </summary>
        public const string Bash = "bash";

        public const string PowerShell = "powershell";
        public const string Python = "python";
    }

    /// <summary>
    /// 平台默认 shell 工具向模型展示的名字：Windows 为 "cmd"（cmd.exe 命令提示符），
    /// 其他平台为 "bash"。BashTool 据此决定 Name / Definition / PromptSnippet / PromptGuidelines；
    /// Windows 上保留 "bash" 兼容别名（见 <see cref="Executor"/> 构造），旧提示词仍可调用。
    /// </summary>
    public static string PlatformShellName => OperatingSystem.IsWindows() ? "cmd" : "bash";

    /// <summary>全部内置工具名（对应 pi 的 allToolNames）。</summary>
    public static readonly IReadOnlySet<string> AllToolNames = new HashSet<string>(
        [ToolNames.ReadFile, ToolNames.WriteFile, ToolNames.EditFile, ToolNames.Glob, ToolNames.Grep, ToolNames.Bash, ToolNames.PowerShell, ToolNames.Python],
        StringComparer.Ordinal);

    /// <summary>
    /// 可写工具集（能修改文件系统）——对应 pi 的 coding tools。
    /// 最后一个成员 <see cref="ToolNames.Bash"/> 是内部注册键，实际展示名随平台
    /// （Windows 为 "cmd"），见 <see cref="PlatformShellName"/>。
    /// </summary>
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
    /// 全局规则（跨工具的操作约定），与各工具自带的 <see cref="ICoreTool.PromptGuidelines"/> 一起
    /// 由 <see cref="BuildInstructions"/> 聚合进系统提示词的规则区。
    /// </summary>
    private static readonly string[] GlobalPromptGuidelines =
    [
        "观察结果以 \"exit: N\"（退出码）或 \"error: ...\"（出错）开头；error 表示修正参数后重试",
        "长输出会被截断（保留头尾）；必要时缩小搜索范围或分批读取",
        "回答要简洁",
    ];

    /// <summary>
    /// 构建工具使用说明：作为 stable_prefix 的一部分注入系统提示（对齐 pi 的 system prompt 写法）。
    /// <list type="bullet">
    /// <item>工具清单：一行一个工具，snippet 来自各工具的 <see cref="ICoreTool.PromptSnippet"/>——
    ///     只写做什么，参数细节已在 <see cref="ChatTool.Definition"/> 的 schema 里，不重复。</item>
    /// <item>规则：全局 <see cref="GlobalPromptGuidelines"/> + 各工具贡献的
    ///     <see cref="ICoreTool.PromptGuidelines"/>（去重、命令式短句）——schema 表达不了的操作知识。</item>
    /// </list>
    /// 说明文本由工具自身贡献，与 schema 同源、不再手写同步；人格（简洁 ReAct 助手、中文回答）
    /// 由宿主在 `Di.Cli/CliHost.cs` 追加，不在此重复。
    /// </summary>
    public static string BuildInstructions(string baseDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(baseDirectory);

        // bash/powershell 挂上临时会话 → 工具处于"共享持久化会话"形态（与 CreateExecutor 一致），
        // 提示词里对会话状态的描述才成立；会话是惰性的，不执行命令不会拉起进程。
        using var session = new ShellSession(baseDirectory);
        using var powerShellSession = new ShellSession(baseDirectory, ShellCommand.PowerShellSession);
        var tools = CreateTools(baseDirectory, session: session, powerShellSession: powerShellSession);

        var sb = new StringBuilder();
        sb.AppendLine("你是 Di 编程助手，可以在工作区中读取、编写、修改文件，并运行命令与代码。");
        sb.AppendLine();
        sb.AppendLine("工具：");
        foreach (var tool in tools)
            sb.AppendLine($"- {tool.Name} —— {tool.PromptSnippet}");
        sb.AppendLine();
        sb.AppendLine("规则：");
        foreach (var rule in BuildRules(tools))
            sb.AppendLine($"- {rule}");
        return sb.ToString();
    }

    /// <summary>聚合全局规则 + 各工具规则，去重（保留首次出现顺序）。</summary>
    private static IReadOnlyList<string> BuildRules(IEnumerable<ICoreTool> tools)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var rules = new List<string>();
        void Add(string rule)
        {
            var normalized = rule.Trim();
            if (normalized.Length == 0 || !seen.Add(normalized))
                return;
            rules.Add(normalized);
        }

        foreach (var rule in GlobalPromptGuidelines)
            Add(rule);
        foreach (var tool in tools)
        {
            foreach (var rule in tool.PromptGuidelines)
                Add(rule);
        }
        return rules;
    }

    /// <summary>把 ToolCallBlock 按工具名分发给对应工具，未知工具返回错误观察。</summary>
    public sealed class Executor : IToolExecutor, IDisposable
    {
        private readonly IReadOnlyDictionary<string, ICoreTool> _tools;
        private readonly ShellSession? _session;
        private readonly ShellSession? _powerShellSession;

        public Executor(IEnumerable<ICoreTool> tools, ShellSession? session = null, ShellSession? powerShellSession = null)
        {
            var dict = new Dictionary<string, ICoreTool>(StringComparer.Ordinal);
            foreach (var tool in tools)
                dict[tool.Name] = tool;
            // 兼容别名：非 Windows 上 shell 工具名本就是 "bash"（无需别名）；
            // Windows 上展示名是 "cmd"，但旧提示词 / 旧 skill 可能写 "bash"，路由到同一实例。
            if (dict.TryGetValue(CoreTools.PlatformShellName, out var shellTool) && !dict.ContainsKey(ToolNames.Bash))
                dict[ToolNames.Bash] = shellTool;
            _tools = dict;
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
