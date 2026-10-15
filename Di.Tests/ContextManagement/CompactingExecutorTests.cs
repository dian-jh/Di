using Core.AgentLoop;
using Core.ContextManagement;
using Core.Llm;
using Core.Tools;

namespace Di.Tests.ContextManagement;

/// <summary>
/// <see cref="CompactingExecutor"/>（L1 工具结果预算控制）测试：假内层执行器 + 假落盘存储。
/// 契约见 docs/context-compression.md §3.1 / §6.3。
/// </summary>
public sealed class CompactingExecutorTests
{
    private const int Window = 1_000;
    private const int SoftThresholdTokens = 700;   // budget 1000 × 0.7（margin/output 归零）

    // ---- 小输出直通 ----

    [Fact]
    public async Task SmallOutput_FromClearableTool_PassesThrough_Unchanged()
    {
        var store = new FakeStore();
        var executor = new CompactingExecutor(new FakeInner(_ => "ok"), Policy(), store);

        var result = await executor.ExecuteAsync(Call("read_file"));

        Assert.Equal("ok", result);
        Assert.Empty(store.Written);
    }

    // ---- 大输出白名单工具 → 落盘 + 摘要 ----

    [Fact]
    public async Task LargeOutput_FromClearableTool_WritesFullArtifact_AndReturnsSummary()
    {
        var store = new FakeStore();
        var full = BigOutput();                       // 50k 字符 ≈12500 token > 700 soft
        var executor = new CompactingExecutor(new FakeInner(_ => full), Policy(), store);

        var result = await executor.ExecuteAsync(Call("read_file"));

        var written = Assert.Single(store.Written);
        Assert.Equal("read_file", written.Tool);
        Assert.Equal(full, written.Content);          // 完整输出落盘，非摘要
        Assert.NotEqual(full, result);                // 上下文里不再塞完整输出
        Assert.True(result.Length < full.Length);     // 摘要显著更小
        Assert.Contains(written.Path, result);        // artifactRef 出现在上下文
        Assert.Contains("省略", result);              // 含截断提示（头 + 省略 + 尾）
    }

    [Fact]
    public async Task LargeShellOutput_PlatformShellNameAndBashAlias_AreBothClearable()
    {
        foreach (var name in new[] { CoreTools.PlatformShellName, CoreTools.ToolNames.Bash })
        {
            var store = new FakeStore();
            var executor = new CompactingExecutor(new FakeInner(_ => BigOutput()), Policy(), store);

            await executor.ExecuteAsync(Call(name));

            var written = Assert.Single(store.Written);
            Assert.Equal(name, written.Tool);
        }
    }

    // ---- edit_file / write_file 永不落盘改写 ----

    [Theory]
    [InlineData("edit_file")]
    [InlineData("write_file")]
    public async Task LargeOutput_FromMutableTools_NeverArtifacted(string toolName)
    {
        var store = new FakeStore();
        var full = BigOutput();
        var executor = new CompactingExecutor(new FakeInner(_ => full), Policy(), store);

        var result = await executor.ExecuteAsync(Call(toolName));

        Assert.Equal(full, result);          // 完整文本原样进上下文
        Assert.Empty(store.Written);         // 绝不落盘改写
    }

    [Fact]
    public async Task LargeOutput_FromNonWhitelistedTool_PassesThrough()
    {
        var store = new FakeStore();
        var full = BigOutput();
        var executor = new CompactingExecutor(new FakeInner(_ => full), Policy(), store);

        var result = await executor.ExecuteAsync(Call("curl"));

        Assert.Equal(full, result);
        Assert.Empty(store.Written);
    }

    // ---- 内层异常必须原样上抛（不是"落盘失败"的 fail-safe 兜底）----

    [Fact]
    public async Task InnerExecutorException_Propagates_NotSwallowedAsDiskFailure()
    {
        var executor = new CompactingExecutor(
            new FakeInner(_ => throw new InvalidOperationException("boom")), Policy(), new FakeStore());

        await Assert.ThrowsAsync<InvalidOperationException>(() => executor.ExecuteAsync(Call("read_file")));
    }

    // ---- CancellationToken 透传给内层执行器 ----

    [Fact]
    public async Task CancellationToken_IsForwardedToInnerExecutor()
    {
        var inner = new FakeInner(_ => "ok");
        var executor = new CompactingExecutor(inner, Policy(), new FakeStore());
        using var cts = new CancellationTokenSource();

        await executor.ExecuteAsync(Call("read_file"), cts.Token);

        Assert.Equal(cts.Token, inner.LastCancellationToken);
    }

    // ---- 摘要上界不变式：摘要+引用行不小于原文 → 不落盘 ----

    [Fact]
    public async Task Output_AtPreviewBudget_SummaryNotStrictlySmaller_IsNotSpilled()
    {
        // full = 头 6000 + 尾 18000 = 24000 字符：摘要体 = 全文，"摘要 + 引用行"必然更大 →
        // 完整文本进上下文，不落盘（否则上下文膨胀 + 白写文件）。
        var store = new FakeStore();
        var atPreviewBudget = new string('D', 24_000);
        var executor = new CompactingExecutor(new FakeInner(_ => atPreviewBudget), Policy(), store);

        var result = await executor.ExecuteAsync(Call("read_file"));

        Assert.Equal(atPreviewBudget, result);
        Assert.Empty(store.Written);
    }

    // ---- 落盘失败 → fail-safe 回退完整文本，绝不打断回合 ----

    [Fact]
    public async Task WriteFailure_FallsBackToFullText_WithoutThrowing()
    {
        var store = new FakeStore { ThrowOnWrite = true };
        var full = BigOutput();
        var executor = new CompactingExecutor(new FakeInner(_ => full), Policy(), store);

        var result = await executor.ExecuteAsync(Call("read_file"));

        Assert.Equal(full, result);          // 回退为完整文本进上下文
    }

    // ---- B_current 累计参与 B_predicted 判定（§6.3）----

    [Fact]
    public async Task CurrentInputTokens_ContributeToPrediction()
    {
        var small = new string('A', 196);    // 49 token
        // current 650 + 49 = 699 < 700 → 直通。
        var near = new CompactingExecutor(new FakeInner(_ => small), Policy(), new FakeStore(),
            currentInputTokens: () => 650);
        Assert.Equal(small, await near.ExecuteAsync(Call("read_file")));

        // current 651 + 12500（50k 字符大输出）= 13151 ≥ 700 → 落盘摘要。
        var store = new FakeStore();
        var over = new CompactingExecutor(new FakeInner(_ => BigOutput()), Policy(), store,
            currentInputTokens: () => 651);
        var result = await over.ExecuteAsync(Call("read_file"));
        Assert.NotEqual(BigOutput(), result);
        Assert.Single(store.Written);

        // 越线但输出太小（摘要不严格更小，上界不变式）→ 全文进上下文，不落盘。
        var tinyStore = new FakeStore();
        var tiny = new CompactingExecutor(new FakeInner(_ => small), Policy(), tinyStore,
            currentInputTokens: () => 651);   // 651 + 49 = 700 ≥ 700 已越线
        Assert.Equal(small, await tiny.ExecuteAsync(Call("read_file")));
        Assert.Empty(tinyStore.Written);
    }

    // ---- artifact 文件往返可读（真实文件系统）----

    [Fact]
    public async Task LargeOutput_ArtifactFile_IsReadableAndRoundTrips()
    {
        var root = Path.Combine(Path.GetTempPath(), "di-cm-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var store = new ArtifactStore(root, new DateTimeOffset(2026, 10, 15, 8, 30, 0, TimeSpan.Zero));
            var full = BigOutput();
            var executor = new CompactingExecutor(new FakeInner(_ => full), Policy(), store);

            var result = await executor.ExecuteAsync(Call("grep"));

            var files = Directory.GetFiles(store.ArtifactsDirectory, "*.txt");
            var file = Assert.Single(files);
            Assert.Equal(full, await File.ReadAllTextAsync(file));   // 落盘内容 = 完整输出，往返可读
            Assert.Contains(store.ArtifactsDirectory, result);       // 摘要引用真实落盘路径
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static string BigOutput() => new('C', 50_000);   // ≈12500 token > 700 soft

    private static BudgetPolicy Policy() =>
        new(Window, marginRatio: 0, outputReserveTokens: 0, nextOutputReserveTokens: 0);

    private static ToolCallBlock Call(string name) => new($"id-{name}", name, "{}");

    private sealed class FakeInner : IToolExecutor
    {
        private readonly Func<ToolCallBlock, string> _handler;
        public List<ToolCallBlock> Calls { get; } = [];
        public CancellationToken LastCancellationToken { get; private set; }
        public FakeInner(Func<ToolCallBlock, string> handler) => _handler = handler;

        public Task<string> ExecuteAsync(ToolCallBlock call, CancellationToken cancellationToken = default)
        {
            Calls.Add(call);
            LastCancellationToken = cancellationToken;
            return Task.FromResult(_handler(call));
        }
    }

    private sealed class FakeStore : IArtifactStore
    {
        public bool ThrowOnWrite { get; init; }
        public List<(string Tool, string Content, string Path)> Written { get; } = [];

        public string Write(string toolName, string content)
        {
            if (ThrowOnWrite)
                throw new IOException("disk full");
            var path = Path.Combine("artifacts", $"tool-{toolName}.txt");
            Written.Add((toolName, content, path));
            return path;
        }
    }
}