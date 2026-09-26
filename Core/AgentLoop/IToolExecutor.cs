using Core.Llm;

namespace Core.AgentLoop;

/// <summary>
/// 工具执行抽象（伪代码里的 <c>Environment.execute</c>）。
/// loop 层不认识任何具体工具 —— 执行能力由外部注入。
/// </summary>
public interface IToolExecutor
{
    /// <summary>
    /// 执行一次（已校验的）工具调用，返回回填给模型的观察结果字符串。
    /// 实现可以抛异常 —— loop 会把异常转换成错误观察结果，而不是让整个运行崩溃。
    /// </summary>
    Task<string> ExecuteAsync(ToolCallBlock call, CancellationToken cancellationToken = default);
}
