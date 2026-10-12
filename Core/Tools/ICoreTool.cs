using Core.Llm;

namespace Core.Tools;

/// <summary>
/// 内置编码工具（Coding Agent 的八个核心工具）的统一形态：
/// 每个工具 = 一个 <see cref="ChatTool"/> 定义（给模型的 JSON Schema）+ 一个执行实现。
/// </summary>
public interface ICoreTool
{
    /// <summary>工具名，也是模型调用时使用的名字。</summary>
    string Name { get; }

    /// <summary>给模型的工具定义（name / description / parameters）。</summary>
    ChatTool Definition { get; }

    /// <summary>
    /// 系统提示词中该工具的一行简介（对应 pi 的 promptSnippet）。
    /// 只写"做什么"，参数细节在 <see cref="Definition"/> 的 schema 里，不重复。
    /// </summary>
    string PromptSnippet { get; }

    /// <summary>
    /// 该系统工具贡献给系统提示词规则区的规则（对应 pi 的 promptGuidelines）——
    /// 命令式短句，schema 表达不了的操作知识（行为偏好、协议、观察约定）。
    /// 由 <c>CoreTools.BuildInstructions</c> 聚合进系统提示词，与 schema 同源、不再手写同步。
    /// </summary>
    IReadOnlyList<string> PromptGuidelines { get; }

    /// <summary>
    /// 执行一次工具调用。参数是模型生成的原始 JSON 字符串。
    /// 成功返回结果文本；可预期的失败（参数缺失、文件不存在等）返回以 "error:" 开头的观察文本，
    /// 由模型在下一轮自行纠正（错误以普通工具结果身份进入上下文）。
    /// </summary>
    Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default);
}
