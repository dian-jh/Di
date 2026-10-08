using Core.Llm;

namespace Core.Tools;

/// <summary>
/// 内置编码工具（Coding Agent 的七个核心工具）的统一形态：
/// 每个工具 = 一个 <see cref="ChatTool"/> 定义（给模型的 JSON Schema）+ 一个执行实现。
/// </summary>
public interface ICoreTool
{
    /// <summary>工具名，也是模型调用时使用的名字。</summary>
    string Name { get; }

    /// <summary>给模型的工具定义（name / description / parameters）。</summary>
    ChatTool Definition { get; }

    /// <summary>
    /// 执行一次工具调用。参数是模型生成的原始 JSON 字符串。
    /// 成功返回结果文本；可预期的失败（参数缺失、文件不存在等）返回以 "error:" 开头的观察文本，
    /// 由模型在下一轮自行纠正（错误以普通工具结果身份进入上下文）。
    /// </summary>
    Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default);
}
