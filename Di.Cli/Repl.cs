using Common.Events;
using Core.AgentLoop;

namespace Di.Cli;

/// <summary>
/// 外层循环（Human REPL）：读取一行 → 处理斜杠命令 → 运行一个 agent 回合。
/// 回合开始前先创建 <see cref="AgentLoopEvent"/> 消费者，运行结束后排空本回合全部事件并渲染，
/// 再渲染最终回答 —— 事件经总线从 ReAct 流到 UI，两者互不耦合。
/// </summary>
public sealed class Repl
{
    private readonly IAgentRunner _runner;
    private readonly IEventBus _bus;
    private readonly ILineReader _reader;
    private readonly TextWriter _output;
    private readonly ReplOptions _options;
    private readonly EventRenderer _renderer;

    public Repl(IAgentRunner runner, IEventBus bus, ILineReader reader, TextWriter output, ReplOptions options)
    {
        _runner = runner ?? throw new ArgumentNullException(nameof(runner));
        _bus = bus ?? throw new ArgumentNullException(nameof(bus));
        _reader = reader ?? throw new ArgumentNullException(nameof(reader));
        _output = output ?? throw new ArgumentNullException(nameof(output));
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _renderer = new EventRenderer(output);
    }

    public async Task RunAsync(CancellationToken cancellationToken = default)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            _output.Write(_options.Prompt);
            _output.Flush();

            var line = await _reader.ReadLineAsync(cancellationToken);
            if (line is null)
                break;   // EOF

            line = line.Trim();
            if (line.Length == 0)
                continue;

            if (line.StartsWith('/'))
            {
                if (RunCommand(line))
                    break;   // /exit
                continue;
            }

            await RunTurnAsync(line, cancellationToken);
        }
    }

    /// <summary>一次聊天回合：先建消费者，再运行，最后排空事件并渲染回答。</summary>
    private async Task RunTurnAsync(string userMessage, CancellationToken cancellationToken)
    {
        using var consumer = _bus.CreateConsumer<AgentLoopEvent>();

        AgentResult result;
        try
        {
            result = await _runner.RunAsync(userMessage, cancellationToken);
        }
        catch (Exception ex)
        {
            _output.WriteLine($"  ✗ 运行失败: {ex.Message}");
            return;
        }

        while (consumer.TryRead() is { } evt)
            _renderer.Render(evt);
        _renderer.RenderResult(result);
    }

    /// <summary>斜杠命令；返回 true 表示退出。</summary>
    private bool RunCommand(string command)
    {
        var (name, args) = SplitCommand(command);
        switch (name)
        {
            case "/exit":
                return true;
            case "/help":
                _output.WriteLine(_options.HelpText);
                break;
            case "/clear":
                _output.Write("\x1b[2J\x1b[H");   // ANSI 清屏（主屏幕）
                break;
            case "/model" when args.Length > 0:
                _runner.CurrentModel = args;
                _output.WriteLine($"模型已切换为 {args}");
                break;
            case "/model":
                _output.WriteLine("用法: /model <模型名>");
                break;
            default:
                _output.WriteLine($"未知命令: {name}（输入 /help 查看帮助）");
                break;
        }
        return false;
    }

    private static (string Name, string Args) SplitCommand(string command)
    {
        var space = command.IndexOf(' ');
        return space < 0 ? (command, string.Empty) : (command[..space], command[(space + 1)..].Trim());
    }
}
