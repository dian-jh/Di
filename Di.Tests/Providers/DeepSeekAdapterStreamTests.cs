using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using Core.Llm;
using Core.Providers.DeepSeek;

namespace Di.Tests.Providers;

/// <summary>
/// 针对 <see cref="DeepSeekAdapter.StreamAsync"/> 的流式传输测试（用假 HttpMessageHandler 模拟 SSE）。
/// 关注点：SSE 正常收尾、流被中途截断（EOF 无 [DONE]）、传输层异常（连接被掐断）、空闲超时 ——
/// 这些"流式中断"都必须以<b>可重试</b>的 <see cref="LlmException"/> 抛出，让
/// <see cref="RetryingChatModel"/> 能整体重试，而不是把回合直接打死（历史 bug：HttpIOException
/// 裸抛 → Repl 打印 "The response ended prematurely. (ResponseEnded)"）。
/// </summary>
public sealed class DeepSeekAdapterStreamTests
{
    [Fact]
    public async Task StreamAsync_SseWithDone_YieldsTextThenStop()
    {
        // 真实 DeepSeek 流的收尾形态：最后一个 chunk 是空 delta + finish_reason:"stop"，随后 [DONE]。
        var sse = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\"},\"finish_reason\":null}]}\n\n" +
                  "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
                  "data: [DONE]\n\n";
        var adapter = Adapter(SseResponse(new ScriptedStream(sse)));

        var events = new List<StreamChunk>();
        await foreach (var chunk in adapter.StreamAsync(Options(), CancellationToken.None))
            events.Add(chunk);

        Assert.Contains(events, c => c is StreamChunk.TextDelta { Text: "你好" });
        Assert.Contains(events, c => c is StreamChunk.Finish { Reason: FinishReason.Stop });
    }

    [Fact]
    public async Task StreamAsync_EofWithoutDone_ThrowsRetryableConnection()
    {
        // 服务器把流掐在 [DONE] 之前（干净 EOF）：协议层截断，属于传输故障 → 可重试 Connection。
        var sse = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\"},\"finish_reason\":null}]}\n\n";
        var adapter = Adapter(SseResponse(new ScriptedStream(sse)));

        var ex = await ThrowsLlmAsync(adapter);

        Assert.True(ex.IsRetryable, "流截断应可重试，否则 RetryingChatModel 不兜底");
        Assert.Equal(LlmErrorCodes.Connection, ex.Code);
    }

    [Fact]
    public async Task StreamAsync_TransportErrorMidStream_ThrowsRetryableConnection()
    {
        // 连接在读到一半时被掐断：System.Net.Http 抛 HttpIOException（"The response ended prematurely."）——
        // 适配器必须把它翻译成可重试的 LlmException，而不是裸抛。
        var stream = new ScriptedStream(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\"},\"finish_reason\":null}]}\n\n",
            throwAfterContent: new HttpIOException(HttpRequestError.ResponseEnded, "The response ended prematurely."));
        var adapter = Adapter(SseResponse(stream));

        var ex = await ThrowsLlmAsync(adapter);

        Assert.True(ex.IsRetryable);
        Assert.Equal(LlmErrorCodes.Connection, ex.Code);
        Assert.IsType<HttpIOException>(ex.InnerException);
    }

    [Fact]
    public async Task StreamAsync_IdleTimeout_ThrowsRetryableTimeout()
    {
        // 服务器发了首个 chunk 后不再发数据（挂起）：空闲超时应触发并抛可重试 Timeout。
        var stream = new BlockingStream();
        var adapter = Adapter(SseResponse(stream),
            new DeepSeekAdapterConfig { ApiKey = "test-key", StreamIdleTimeoutSeconds = 0.2 });

        var ex = await ThrowsLlmAsync(adapter);

        Assert.True(ex.IsRetryable);
        Assert.Equal(LlmErrorCodes.Timeout, ex.Code);
    }

    [Fact]
    public async Task StreamAsync_NonRetryableLlmError_PropagatesAsIs()
    {
        // 鉴权失败等不可重试故障：适配器不得改成可重试。
        var adapter = Adapter(SseResponse(new ScriptedStream("data: [DONE]\n\n")), new DeepSeekAdapterConfig());
        var options = Options() with { ApiKey = "" };

        var ex = await Assert.ThrowsAsync<LlmException>(async () =>
        {
            await foreach (var _ in adapter.StreamAsync(options, CancellationToken.None)) { }
        });

        Assert.Equal(LlmErrorCodes.MissingCredential, ex.Code);
        Assert.False(ex.IsRetryable);
    }

    private static async Task<LlmException> ThrowsLlmAsync(DeepSeekAdapter adapter)
        => await Assert.ThrowsAsync<LlmException>(async () =>
        {
            await foreach (var _ in adapter.StreamAsync(Options(), CancellationToken.None)) { }
        });

    private static GenerateOptions Options() => new()
    {
        Provider = DeepSeekDefaults.ProviderId,
        Model = "deepseek-flash",
        Messages = [ChatMessage.User("hi")],
        ApiKey = "test-key",
    };

    private static DeepSeekAdapter Adapter(HttpResponseMessage response, DeepSeekAdapterConfig? config = null)
        => new(new HttpClient(new StubHandler(response)), config ?? new DeepSeekAdapterConfig { ApiKey = "test-key" });

    private static HttpResponseMessage SseResponse(Stream stream) => new(HttpStatusCode.OK)
    {
        Content = new StreamContent(stream)
        {
            Headers = { ContentType = new MediaTypeHeaderValue("text/event-stream") },
        },
    };

    /// <summary>返回固定 SSE 字节；读完后可选抛异常（模拟连接被掐断），否则返回 0（EOF）。</summary>
    private sealed class ScriptedStream : Stream
    {
        private readonly byte[] _content;
        private int _pos;
        private readonly Exception? _throwAfterContent;

        public ScriptedStream(string sse, Exception? throwAfterContent = null)
        {
            _content = Encoding.UTF8.GetBytes(sse);
            _throwAfterContent = throwAfterContent;
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_pos >= _content.Length)
            {
                if (_throwAfterContent is not null)
                    throw _throwAfterContent;
                return 0;
            }
            var n = Math.Min(count, _content.Length - _pos);
            Array.Copy(_content, _pos, buffer, offset, n);
            _pos += n;
            return n;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    /// <summary>读取永不返回：挂起直到取消（模拟服务器不再下发数据）。</summary>
    private sealed class BlockingStream : Stream
    {
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return 0;
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            Thread.Sleep(Timeout.Infinite);
            return 0;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly HttpResponseMessage _response;
        public StubHandler(HttpResponseMessage response) => _response = response;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(_response);
    }
}
