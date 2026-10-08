using Core.AgentLoop;
using Core.Llm;

namespace Core.Tools;

/// <summary>
/// 七个内置核心编码工具（第五章 Coding Agent）的聚合入口：
/// 工具实例、JSON Schema 定义、<see cref="IToolExecutor"/> 分发、以及放进 stable_prefix 的使用说明。
/// </summary>
public static class CoreTools
{
    /// <summary>创建全部七个核心工具实例（相对路径都以 baseDirectory 为根）。</summary>
    public static IReadOnlyList<ICoreTool> Create(string baseDirectory) =>
    [
        new ReadFileTool(baseDirectory),
        new WriteFileTool(baseDirectory),
        new EditFileTool(baseDirectory),
        new GlobTool(baseDirectory),
        new GrepTool(baseDirectory),
        new BashTool(baseDirectory),
        new PythonTool(),
    ];

    /// <summary>七个工具的 ChatTool 定义，传给模型以允许其发起工具调用。</summary>
    public static IReadOnlyList<ChatTool> Definitions(string baseDirectory) =>
        Create(baseDirectory).Select(t => t.Definition).ToList();

    /// <summary>创建按工具名分发的执行器，供 ReAct 循环使用。</summary>
    public static IToolExecutor CreateExecutor(string baseDirectory) => new Executor(Create(baseDirectory));

    /// <summary>
    /// 工具使用说明：作为 stable_prefix 的一部分注入系统提示，让模型知道有哪七个工具、
    /// 观察结果长什么样、以及各类工具的使用惯例。
    /// </summary>
    public static string Instructions { get; } =
        """
        你是 Di 编程助手，可以在工作区中读取、编写、修改文件，并运行命令与代码。

        内置工具：
        1. read_file —— 读取文件，输出带行号。可用 start_line/end_line 只读某一段；不确定内容时先读再动，不要凭猜。
        2. write_file —— 整体覆盖写入一个文件（是覆盖，不是追加）。覆盖前若不确定文件现状，先用 read_file/glob 确认。
        3. edit_file —— 精准编辑：给出 old_string 与 new_string，把文件中唯一出现的 old_string 替换为 new_string。
           old_string 必须在文件中只出现一次（唯一），否则返回错误；报错时请提供更多上下文使其唯一。
           这是修改文件的推荐方式，比整体重写更安全。
        4. glob —— 按文件名模式（支持 * ? **）搜索文件，返回匹配的相对路径列表。
        5. grep —— 按正则表达式搜索文件内容，返回 file:行号: 内容（如 src/api.py:42: # TODO: ...）。
           定位代码逻辑用 grep，先搜再读，不要编造文件内容。
        6. bash —— 在 shell 中执行一条命令，返回退出码与合并输出（stdout+stderr）。
           适合跑测试、处理特殊格式文件、装依赖。超时（30 秒）返回 error，长输出自动截断头尾。
        7. python —— 在沙盒临时目录中执行一段 Python 代码，适合计算、数据处理、生成图表。超时返回 error，长输出截断。

        使用惯例：
        - 观察结果以 "exit: N"（N 为退出码）或 "error: ..."（本次调用出错）开头。error 表示需要修正参数后重试。
        - 长输出会被截断（保留头尾）；必要时缩小搜索范围或分批读取。
        - 修改文件优先 edit_file（唯一性校验），整体重写才用 write_file。
        """;

    /// <summary>把 ToolCallBlock 按工具名分发给对应工具，未知工具返回错误观察。</summary>
    public sealed class Executor : IToolExecutor
    {
        private readonly IReadOnlyDictionary<string, ICoreTool> _tools;

        public Executor(IEnumerable<ICoreTool> tools)
        {
            _tools = tools.ToDictionary(t => t.Name);
        }

        public Task<string> ExecuteAsync(ToolCallBlock call, CancellationToken cancellationToken = default)
        {
            if (_tools.TryGetValue(call.Name, out var tool))
                return tool.ExecuteAsync(call.Arguments, cancellationToken);
            return Task.FromResult($"error: 未知工具 '{call.Name}'");
        }
    }
}
