namespace Core.Tools;

/// <summary>
/// 有界<b>字节</b>输出累积器（对应字符版 <see cref="OutputBuffer"/>）：
/// 子进程原始字节输出边来边收，头（前 <see cref="HeadBytes"/> 字节）与尾（最后
/// <see cref="TailBytes"/> 字节）分别保留在预算内，超预算的中间丢弃，保证任意长度输出
/// 内存占用恒定。与字符版的关键区别：这里保留的是<b>原始字节</b>，解码推迟到最后
/// （<see cref="ToText"/>），这样整段字节可以一次性做"UTF-8 优先、OEM 回退"的智能解码
/// （<see cref="ProcessEncoding.SmartDecode"/>）——字符版在流式解码的瞬间就锁死了编码，
/// 无法区分同一管道里 cmd 的 OEM 字节与 .NET CLI 的 UTF-8 字节。
/// </summary>
internal sealed class BoundedByteBuffer
{
    /// <summary>保留的头部字节数（通常是命令开头的错误/上下文）。</summary>
    public const int HeadBytes = 6000;

    /// <summary>保留的尾部字节数（通常是命令结尾的结果/总结）。</summary>
    public const int TailBytes = 18000;

    /// <summary>总预算（头 + 尾）。</summary>
    public const int MaxBytes = HeadBytes + TailBytes;

    private readonly object _gate = new();
    private readonly byte[] _head = new byte[HeadBytes];
    private int _headCount;
    private bool _headFrozen;
    private readonly Queue<byte[]> _tail = new();
    private int _tailBytes;
    private long _totalBytes;

    /// <summary>追加一段字节（<paramref name="count"/> 为有效长度）。线程安全：ProcessRunner 的
    /// stdout/stderr 两个排干任务会并发追加到同一缓冲。</summary>
    public void Append(byte[] chunk, int count)
    {
        if (count <= 0)
            return;
        lock (_gate)
        {
            _totalBytes += count;

        if (!_headFrozen)
        {
            var room = HeadBytes - _headCount;
            if (count <= room)
            {
                Buffer.BlockCopy(chunk, 0, _head, _headCount, count);
                _headCount += count;
                if (_headCount == HeadBytes)
                    _headFrozen = true;
                return;
            }
            Buffer.BlockCopy(chunk, 0, _head, _headCount, room);
            _headCount = HeadBytes;
            _headFrozen = true;
            AppendTail(chunk, room, count - room);
            return;
        }

        AppendTail(chunk, 0, count);
        }
    }

    /// <summary>是否发生了截断（收到的总字节数超出预算）。</summary>
    public bool Truncated => _headFrozen && _totalBytes > MaxBytes;

    /// <summary>收到过的总字节数（含被丢弃的中间部分）。</summary>
    public long TotalBytes => _totalBytes;

    /// <summary>
    /// 解码为文本：未截断时头+尾拼成完整字节流一次解码（接缝处不会切断多字节字符）；
    /// 超预算时头、尾分开解码，中间插截断提示（接缝残片由 <see cref="ProcessEncoding.SmartDecode"/>
    /// 自行裁剪，至多损失一个字符）。
    /// </summary>
    public string ToText(Func<byte[], string> decode) => ToText(b => b, decode);

    /// <summary>
    /// 解码为文本（带字节级预处理，如剥掉 cmd 的回显行后再判编码——回显行是 GBK 字节，不剥会污染
    /// 同一段里 .NET CLI 的 UTF-8 输出）。预处理对头、尾分别应用；回显行只出现在输出开头（头部），
    /// 不会横跨头/尾接缝。截断提示位置保持头/尾之间。
    /// </summary>
    public string ToText(Func<byte[], byte[]> preprocess, Func<byte[], string> decode)
    {
        var head = preprocess(_head.AsSpan(0, _headCount).ToArray());
        var tail = preprocess(TailBytesArray());
        if (!_headFrozen || _totalBytes <= MaxBytes)
        {
            var all = new byte[head.Length + tail.Length];
            Buffer.BlockCopy(head, 0, all, 0, head.Length);
            Buffer.BlockCopy(tail, 0, all, head.Length, tail.Length);
            return decode(all);
        }
        var dropped = _totalBytes - (_headCount + _tailBytes);
        return decode(head) + $"\n…[输出过长，已截断中间 {dropped} 字节]…\n" + decode(tail);
    }

    /// <summary>
    /// 返回原始字节（未截断时头+尾即完整内容；截断时只含头尾、中间丢弃，缺口无妨——调用方做
    /// 逐行过滤/解码时只关心行首行尾）。用于解码前的字节级加工（如剥掉 cmd 的回显行）。
    /// </summary>
    public byte[] ToByteArray()
    {
        var tail = TailBytesArray();
        var result = new byte[_headCount + tail.Length];
        Buffer.BlockCopy(_head, 0, result, 0, _headCount);
        Buffer.BlockCopy(tail, 0, result, _headCount, tail.Length);
        return result;
    }

    private void AppendTail(byte[] chunk, int offset, int count)
    {
        if (count <= 0)
            return;
        if (count >= TailBytes)
        {
            _tail.Clear();
            _tailBytes = 0;
            var tailOnly = new byte[TailBytes];
            Buffer.BlockCopy(chunk, offset + count - TailBytes, tailOnly, 0, TailBytes);
            _tail.Enqueue(tailOnly);
            _tailBytes = TailBytes;
            return;
        }
        var slice = new byte[count];
        Buffer.BlockCopy(chunk, offset, slice, 0, count);
        _tail.Enqueue(slice);
        _tailBytes += count;
        while (_tailBytes > TailBytes)
            _tailBytes -= _tail.Dequeue().Length;
    }

    private byte[] TailBytesArray()
    {
        var result = new byte[_tailBytes];
        var pos = 0;
        foreach (var piece in _tail)
        {
            Buffer.BlockCopy(piece, 0, result, pos, piece.Length);
            pos += piece.Length;
        }
        return result;
    }
}
