namespace Core.ContextManagement;

/// <summary>
/// L1 大输出落盘的抽象（docs/context-compression.md §7.1 artifacts/）。
/// 落盘实现可注入假存储做单测；<see cref="CompactingExecutor"/> 只依赖本接口。
/// </summary>
public interface IArtifactStore
{
    /// <summary>
    /// 把一次工具调用的完整输出写入 artifacts 目录，返回落盘文件的完整路径（artifactRef）。
    /// 实现可以抛异常 —— <see cref="CompactingExecutor"/> 捕获后 fail-safe 回退完整文本。
    /// </summary>
    string Write(string toolName, string content);
}