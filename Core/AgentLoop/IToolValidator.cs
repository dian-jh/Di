using Core.Llm;

namespace Core.AgentLoop;

/// <summary>
/// 校验缝（伪代码里的 <c>Harness.validate</c>）。
/// 安全 / 权限校验以后挂在这里；MVP 阶段传 null 即跳过。
/// </summary>
public interface IToolValidator
{
    /// <summary>接受则返回原调用；拒绝则抛异常。</summary>
    ToolCallBlock Validate(ToolCallBlock call);
}
