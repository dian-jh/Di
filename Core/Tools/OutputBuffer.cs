using System.Text;

namespace Core.Tools;

/// <summary>
/// 有界流式输出累积器：子进程输出边来边收，头（前 <see cref="HeadChars"/> 字符）与
/// 尾（最后 <see cref="TailChars"/> 字符）分别保留在预算内，超出预算的部分从中间丢弃，
/// 保证任意长度的输出内存占用恒定（≤ 预算），最终 <see cref="Text"/> 在头尾之间插入
/// 截断提示。
///
/// 为什么不用"收完再截断"：一条几 MB 的命令输出会先把内存打爆（旧实现正是如此——
/// 先灌进 StringBuilder，最后才 Truncate）。这里按字符预算边收边丢，代价是最终文本
/// 是"头 + 提示 + 尾"，丢掉的中间不可恢复。单个超长行也只保留其尾部字符，不会撑爆预算。
/// </summary>
internal sealed class OutputBuffer
{
    /// <summary>保留的头部字符数（通常是命令开头的错误/上下文）。</summary>
    public const int HeadChars = 6000;

    /// <summary>保留的尾部字符数（通常是命令结尾的结果/总结）。</summary>
    public const int TailChars = 18000;

    /// <summary>总预算（头 + 尾）。</summary>
    public const int MaxChars = HeadChars + TailChars;

    private readonly StringBuilder _head = new(HeadChars);
    private string? _frozenHead;   // 头满后冻结成字符串，之后不再增长
    private readonly Queue<string> _tail = new();
    private int _tailChars;
    private long _totalChars;

    /// <summary>追加一行（自动补换行，与 ProcessRunner/ShellSession 的逐行事件对齐）。</summary>
    public void AppendLine(string line) => Append(line + "\n");

    /// <summary>追加一段原始文本（不补换行）。</summary>
    public void Append(string chunk)
    {
        if (chunk.Length == 0)
            return;
        _totalChars += chunk.Length;

        // 头未满：继续收进头部；满了立即冻结，其余部分转入尾部累积。
        if (_frozenHead is null)
        {
            var room = HeadChars - _head.Length;
            if (chunk.Length <= room)
            {
                _head.Append(chunk);
                if (_head.Length == HeadChars)
                    _frozenHead = _head.ToString();
                return;
            }
            _head.Append(chunk, 0, room);
            _frozenHead = _head.ToString();
            chunk = chunk[room..];
        }

        // 单块就超过尾预算：旧尾部整体作废，只保留本块最后 TailChars 字符。
        if (chunk.Length >= TailChars)
        {
            _tail.Clear();
            _tailChars = 0;
            var tailOnly = chunk[^TailChars..];
            _tail.Enqueue(tailOnly);
            _tailChars = tailOnly.Length;
            return;
        }

        _tail.Enqueue(chunk);
        _tailChars += chunk.Length;
        while (_tailChars > TailChars)
            _tailChars -= _tail.Dequeue().Length;
    }

    /// <summary>是否发生了截断（收到的总字符数超出预算）。</summary>
    public bool Truncated => _frozenHead is not null && _totalChars > MaxChars;

    /// <summary>收到过的总字符数（含被丢弃的中间部分）。</summary>
    public long TotalChars => _totalChars;

    /// <summary>
    /// 最终文本：预算内原样返回；超预算 = 头 + 截断提示 + 尾。
    /// 头部满了但整体仍在预算内时也原样返回（无提示，内容全保留）。
    /// </summary>
    public string Text
    {
        get
        {
            var tailText = string.Concat(_tail);
            if (_frozenHead is null)
                return _head.ToString() + tailText;
            if (_totalChars <= MaxChars)
                return _frozenHead + tailText;
            var dropped = _totalChars - (_frozenHead.Length + tailText.Length);
            return _frozenHead + $"\n…[输出过长，已截断中间 {dropped} 字符]…\n" + tailText;
        }
    }
}
