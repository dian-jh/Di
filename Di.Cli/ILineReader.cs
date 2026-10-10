namespace Di.Cli;

/// <summary>逐行输入源（外层 REPL 读取用户输入）。抽象出来便于测试注入。</summary>
public interface ILineReader
{
    /// <summary>读取一行；流结束（EOF）时返回 null。</summary>
    Task<string?> ReadLineAsync(CancellationToken cancellationToken = default);
}

/// <summary>从真实控制台读取输入。</summary>
public sealed class ConsoleLineReader : ILineReader
{
    public Task<string?> ReadLineAsync(CancellationToken cancellationToken = default)
        => Task.FromResult(Console.ReadLine());
}

/// <summary>
/// 从任意 <see cref="TextReader"/> 读取输入（测试 / 管道 / 文件均可用，不依赖真实控制台）。
/// 交互模式经 CliApp 用 stdin 构造，使 REPL 与具体 I/O 解耦。
/// </summary>
public sealed class StreamLineReader : ILineReader
{
    private readonly TextReader _reader;

    public StreamLineReader(TextReader reader)
    {
        _reader = reader ?? throw new ArgumentNullException(nameof(reader));
    }

    public Task<string?> ReadLineAsync(CancellationToken cancellationToken = default)
        => _reader.ReadLineAsync(cancellationToken).AsTask();
}
