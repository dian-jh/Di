namespace Core.Llm;

/// <summary>
/// 适配器发出的原始流式协议（对应 DSH 的 StreamChunk）。
///
/// 协议义务（DSH 两个实现共同验证的约定，适配器必须遵守）：
/// <list type="number">
/// <item><c>Usage</c> 必须在 <c>Finish</c> <b>之前</b>发出；<c>Finish</c> 之后不得再发出任何内容。</item>
/// <item>工具调用的 arguments 全程为<b>原始 JSON 字符串</b>，流式片段走 <see cref="ToolCallDelta.ArgumentsDelta"/>。
/// 若提供方返回已解析对象，适配器在块结束时重新 stringify。</item>
/// <item>按<b>首次出现的流顺序</b>分配块 index；同一个块的每次 delta 复用该 index。</item>
/// <item>错误只有两条合法路径：从 <see cref="ChatAdapter.StreamAsync"/> <b>抛出</b>（传输与协议故障，
/// 用带稳定 code 的 <see cref="LlmException"/>），或以 <c>Finish(Error/Aborted)</c> 结束流（提供方带内故障）。</item>
/// </list>
/// </summary>
public abstract record StreamChunk
{
    public sealed record BlockStart(int Index, string BlockType) : StreamChunk;

    public sealed record TextDelta(int Index, string Text) : StreamChunk;

    /// <summary>推理内容增量。独立于可见文本。</summary>
    public sealed record ReasoningDelta(int Index, string Text) : StreamChunk;

    /// <summary>工具调用增量。同一调用多次出现，Id 只在首个增量出现。</summary>
    public sealed record ToolCallDelta(int Index, string Id, string? Name, string ArgumentsDelta) : StreamChunk;

    /// <summary>块结束，携带装配好的完整块。</summary>
    public sealed record BlockEnd(int Index, IContentBlock Block) : StreamChunk;

    /// <summary>★ 必须在 Finish 之前发出。</summary>
    public sealed record Usage(TokenUsage Tokens) : StreamChunk;

    /// <summary>★ 之后不得再发出任何内容。</summary>
    public sealed record Finish(FinishReason Reason) : StreamChunk;
}
