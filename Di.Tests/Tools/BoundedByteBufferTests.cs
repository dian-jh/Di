using System.Text;
using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>
/// 针对 <see cref="BoundedByteBuffer"/>（有界字节累积器，见 Core/Tools/BoundedByteBuffer.cs）的单元测试。
/// 覆盖：预算内整段解码、超预算截断提示、UTF-8 多字节字符被头/尾接缝切断时整段不误判编码。
/// </summary>
public sealed class BoundedByteBufferTests
{
    [Fact]
    public void Append_UnderBudget_ToText_ReturnsWholeDecoded()
    {
        var buffer = new BoundedByteBuffer();
        var bytes = Encoding.UTF8.GetBytes("你好世界 hello world");

        buffer.Append(bytes, bytes.Length);

        Assert.False(buffer.Truncated);
        Assert.Equal("你好世界 hello world", buffer.ToText(ProcessEncoding.SmartDecode));
    }

    [Fact]
    public void Append_Chunked_KeepsOrder()
    {
        var buffer = new BoundedByteBuffer();
        var first = Encoding.UTF8.GetBytes("abc");
        var second = Encoding.UTF8.GetBytes("def");

        buffer.Append(first, 2);   // "ab"
        buffer.Append(first, 3);   // 再加 "abc"（覆盖）
        buffer.Append(second, 3);  // "def"

        Assert.Equal("ababcdef", buffer.ToText(ProcessEncoding.SmartDecode));
    }

    [Fact]
    public void Append_OverBudget_TruncatesHeadAndTail_WithNotice()
    {
        var buffer = new BoundedByteBuffer();
        var chunk = Encoding.UTF8.GetBytes("abcdefghij");
        for (var i = 0; i < 3000; i++)
            buffer.Append(chunk, chunk.Length);

        var text = buffer.ToText(ProcessEncoding.SmartDecode);

        Assert.True(buffer.Truncated);
        Assert.Contains("已截断", text);
        Assert.StartsWith("abcdefghij", text);   // 头部保留
        Assert.EndsWith("abcdefghij", text.TrimEnd());   // 尾部保留
    }

    [Fact]
    public void Append_SplitUtf8Char_AcrossHeadTailSeam_DoesNotGarbleWholeHead()
    {
        // 构造一个恰好把 3 字节中文字符切开在头(6000B)/尾(18000B)接缝上的超长输出：
        // 头 = "A"*5998 + "好"前 2 字节（E5 A5），尾 = "好"*6000（18000 字节整）。
        // 修复前：头段整段严格 UTF-8 失败 → 回退 OEM → 前 5998 个 A 后面出现乱码字符；
        // 修复后：裁掉接缝残片，头段仍是干净 ASCII，不出现替换符/乱码。
        var buffer = new BoundedByteBuffer();
        buffer.Append(Encoding.UTF8.GetBytes(new string('A', BoundedByteBuffer.HeadBytes - 2)), BoundedByteBuffer.HeadBytes - 2);
        var chinese = Encoding.UTF8.GetBytes(new string('好', 7000));
        buffer.Append(chinese, chinese.Length);

        var text = buffer.ToText(ProcessEncoding.SmartDecode);

        Assert.True(buffer.Truncated);
        Assert.Contains("已截断", text);
        // 头段：前 5998 个 A 原样保留（修复后不会因接缝被整段误判）。
        Assert.StartsWith(new string('A', BoundedByteBuffer.HeadBytes - 2), text);
        // 整段不出现 U+FFFD 替换符。
        Assert.DoesNotContain('�', text);
        // 尾部中文仍在。
        Assert.Contains("好", text);
    }

    [Fact]
    public void ToText_WithOverrideEncoding_IgnoresSmartDecode()
    {
        // git/python 传显式 UTF-8 覆盖时，字节按该编码解码，不走 UTF-8 优先/OEM 回退。
        var buffer = new BoundedByteBuffer();
        var bytes = Encoding.UTF8.GetBytes("你好");

        buffer.Append(bytes, bytes.Length);

        Assert.Equal("你好", buffer.ToText(b => Encoding.UTF8.GetString(b)));
    }

    [Fact]
    public void TotalBytes_CountsEverythingEvenWhenTruncated()
    {
        var buffer = new BoundedByteBuffer();
        var chunk = new byte[100];
        Array.Fill(chunk, (byte)'x');
        for (var i = 0; i < 400; i++)
            buffer.Append(chunk, chunk.Length);

        Assert.Equal(40_000, buffer.TotalBytes);
        Assert.True(buffer.Truncated);
        Assert.True(buffer.TotalBytes > BoundedByteBuffer.MaxBytes);
    }
}
