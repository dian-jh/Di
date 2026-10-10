using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>
/// 针对 <see cref="OutputBuffer"/>（有界流式输出累积器）的单元测试。
/// 核心不变量：任意长度的输出，最终文本长度受预算约束（头 + 尾），
/// 超出预算的部分从中间丢弃并插入截断标记，头尾内容不丢。
/// </summary>
public sealed class OutputBufferTests
{
    [Fact]
    public void Empty_ReturnsEmpty()
    {
        var buffer = new OutputBuffer();

        Assert.Equal(string.Empty, buffer.Text);
        Assert.False(buffer.Truncated);
        Assert.Equal(0, buffer.TotalChars);
    }

    [Fact]
    public void UnderBudget_ReturnsFullText()
    {
        var buffer = new OutputBuffer();
        buffer.AppendLine("one");
        buffer.AppendLine("two");

        Assert.False(buffer.Truncated);
        Assert.Equal("one\ntwo\n", buffer.Text);
    }

    [Fact]
    public void HeadFilled_ButWithinBudget_NoTruncationMarker()
    {
        // 头满（6000）但整体未超预算（尾 17000，合计 23000 < 24000）：
        // 内容全保留，不出现截断标记。
        var buffer = new OutputBuffer();
        buffer.Append(new string('a', 6000));    // 头恰好填满
        buffer.Append(new string('b', 17000));   // 尾（预算内）

        Assert.False(buffer.Truncated);
        var text = buffer.Text;
        Assert.DoesNotContain("已截断", text);
        Assert.StartsWith(new string('a', 6000), text);
        Assert.EndsWith(new string('b', 17000), text);
    }

    [Fact]
    public void OverBudget_KeepsHeadAndTailWithMarker()
    {
        var buffer = new OutputBuffer();
        buffer.Append(new string('a', 6000));    // 头恰好填满
        buffer.Append(new string('b', 500));     // 中间（超预算后被丢弃）
        buffer.Append(new string('c', 20000));   // 尾（单块超过尾预算 → 只留最后 18000）

        var text = buffer.Text;

        Assert.True(buffer.Truncated);
        Assert.StartsWith(new string('a', 6000), text);        // 头完整保留
        Assert.Contains("已截断", text);
        Assert.DoesNotContain('b', text);                       // 中间被丢弃
        Assert.EndsWith(new string('c', 18000), text);          // 尾保留的是最近的输出
        Assert.True(text.Length <= OutputBuffer.MaxChars + 100, $"文本应受预算约束：{text.Length}");
        Assert.True(buffer.TotalChars > OutputBuffer.MaxChars, "收到过的字符数应大于预算（包含被丢掉的中间）");
    }

    [Fact]
    public void SingleHugeLine_KeepsHeadAndTailWithinBudget()
    {
        // 一条 10 万字符的行（如 cat 大文件）：头取前 6000，尾取后 18000，其余丢弃，内存恒定。
        var buffer = new OutputBuffer();
        buffer.Append(new string('x', 100_000));

        var text = buffer.Text;

        Assert.True(buffer.Truncated);
        Assert.StartsWith(new string('x', 6000), text);
        Assert.EndsWith(new string('x', 18000), text);
        Assert.True(text.Length <= OutputBuffer.MaxChars + 100, $"文本应受预算约束：{text.Length}");
    }

    [Fact]
    public void ManyLines_StaysBounded()
    {
        // 上万行输出（如构建日志）：长度受预算约束，不随行数增长。
        var buffer = new OutputBuffer();
        for (var i = 0; i < 10_000; i++)
            buffer.AppendLine($"line {i} content here");

        var text = buffer.Text;

        Assert.True(buffer.Truncated);
        Assert.Contains("已截断", text);
        Assert.True(text.Length <= OutputBuffer.MaxChars + 100, $"文本应受预算约束：{text.Length}");
    }
}
