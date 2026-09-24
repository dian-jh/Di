using System.Text;

namespace Core.Llm;

/// <summary>
/// 把 <see cref="StreamChunk"/> 流装配成一条 <see cref="AssistantMessage"/>。
/// 对应 DSH 的 assembler 职责。
///
/// 按块 index 累积 delta：
/// <list type="bullet">
/// <item>text 块 → TextBlock</item>
/// <item>reasoning 块 → ReasoningBlock</item>
/// <item>tool-call 块 → ToolCallBlock（arguments 是<b>原始 JSON 字符串</b>，delta 拼接）</item>
/// </list>
/// </summary>
public sealed class ChatAssembler
{
    private readonly StringBuilder _text = new();
    private readonly StringBuilder _reasoning = new();
    private readonly SortedDictionary<int, PartialToolCall> _toolCalls = new();

    private readonly List<IContentBlock> _opaqueBlocks = [];

    public void Add(StreamChunk chunk)
    {
        switch (chunk)
        {
            case StreamChunk.TextDelta text:
                _text.Append(text.Text);
                break;

            case StreamChunk.ReasoningDelta reasoning:
                _reasoning.Append(reasoning.Text);
                break;

            case StreamChunk.ToolCallDelta toolCall:
                MergeToolCall(toolCall);
                break;

            case StreamChunk.BlockEnd blockEnd:
                if (blockEnd.Block is not (TextBlock or ReasoningBlock or ToolCallBlock))
                    _opaqueBlocks.Add(blockEnd.Block);
                break;
        }
    }

    public AssistantMessage Build()
    {
        var content = new List<IContentBlock>();
        if (_reasoning.Length > 0)
            content.Add(new ReasoningBlock(_reasoning.ToString()));
        if (_text.Length > 0)
            content.Add(new TextBlock(_text.ToString()));
        foreach (var call in _toolCalls.Values)
        {
            content.Add(new ToolCallBlock(
                call.Id ?? $"call_{call.Index}",
                call.Name ?? string.Empty,
                call.Arguments.Length == 0 ? "{}" : call.Arguments.ToString()));
        }
        content.AddRange(_opaqueBlocks);

        return new AssistantMessage(content);
    }

    private void MergeToolCall(StreamChunk.ToolCallDelta delta)
    {
        if (!_toolCalls.TryGetValue(delta.Index, out var partial))
        {
            partial = new PartialToolCall { Index = delta.Index };
            _toolCalls[delta.Index] = partial;
        }

        partial.Id ??= delta.Id;
        partial.Name ??= delta.Name;

        if (delta.ArgumentsDelta.Length > 0)
            partial.Arguments.Append(delta.ArgumentsDelta);
    }

    private sealed class PartialToolCall
    {
        public int Index { get; init; }
        public string? Id { get; set; }
        public string? Name { get; set; }
        public StringBuilder Arguments { get; } = new();
    }
}
