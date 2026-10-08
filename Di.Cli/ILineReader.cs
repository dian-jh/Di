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
