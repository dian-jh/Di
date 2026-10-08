using Common.Events;
using Core.AgentLoop;
using Core.Sessions;

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
    private readonly SessionLog? _sessionLog;

    public Repl(IAgentRunner runner, IEventBus bus, ILineReader reader, TextWriter output, ReplOptions options,
        SessionLog? sessionLog = null)
    {
        _runner = runner ?? throw new ArgumentNullException(nameof(runner));
        _bus = bus ?? throw new ArgumentNullException(nameof(bus));
        _reader = reader ?? throw new ArgumentNullException(nameof(reader));
        _output = output ?? throw new ArgumentNullException(nameof(output));
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _renderer = new EventRenderer(output, options.UseAnsi);
        _sessionLog = sessionLog;
    }

    public async Task RunAsync(CancellationToken cancellationToken = default)
    {
        // 会话开始时写首行 session_meta（尽力而为：失败只告警，不阻塞 REPL）。
        try
        {
            _sessionLog?.StartSession();
        }
        catch (Exception ex)
        {
            _output.WriteLine($"  ⚠ 会话日志初始化失败: {ex.Message}");
        }

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

    /// <summary>
    /// 一次聊天回合：先建消费者，启动并发渲染任务（实时消费事件流），
    /// 运行结束后取消渲染任务并兜底排空残余事件，最后打印脚注。
    /// </summary>
    private async Task RunTurnAsync(string userMessage, CancellationToken cancellationToken)
    {
        using var consumer = _bus.CreateConsumer<AgentLoopEvent>();
        using var renderCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        var renderTask = RenderAsync(consumer, renderCts.Token);

        // 模型首个输出可能延迟数秒（网络/思考），先给出可见反馈，首个事件到达时被擦除。
        _renderer.ShowStatus(_options.WorkingStatusText);

        var startedAt = DateTimeOffset.UtcNow;   // 记录到会话日志，用于计算 duration_ms

        AgentResult result;
        try
        {
            result = await _runner.RunAsync(userMessage, cancellationToken);
        }
        catch (Exception ex)
        {
            _renderer.ClearStatus();
            _output.WriteLine($"  ✗ 运行失败: {ex.Message}");
            renderCts.Cancel();
            await StopRendererAsync(renderTask);
            return;
        }

        renderCts.Cancel();
        await StopRendererAsync(renderTask);

        // 兜底：取消瞬间渲染任务未消费的残余事件（发布同步入队，不会丢失）。
        while (consumer.TryRead() is { } evt)
            _renderer.Render(evt);

        _renderer.RenderResult(result);

        // 回合结束即落盘（尽力而为，磁盘错误不打断聊天）。
        try
        {
            _sessionLog?.AppendTurn(result, startedAt);
        }
        catch (Exception ex)
        {
            _output.WriteLine($"  ⚠ 会话日志写入失败: {ex.Message}");
        }
    }

    /// <summary>实时消费事件流并渲染（TextDelta 逐字写出，模型生成即显示）。</summary>
    private async Task RenderAsync(IEventConsumer<AgentLoopEvent> consumer, CancellationToken cancellationToken)
    {
        await foreach (var evt in consumer.ConsumeAsync(cancellationToken))
        {
            try
            {
                _renderer.Render(evt);
            }
            catch (Exception)
            {
                // 渲染失败不打断回合。
            }
        }
    }

    /// <summary>等待渲染任务结束；取消导致的 OperationCanceledException 属预期。</summary>
    private static async Task StopRendererAsync(Task renderTask)
    {
        try
        {
            await renderTask;
        }
        catch (OperationCanceledException)
        {
            // 预期：回合结束取消渲染器。
        }
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
                _runner.ResetHistory();           // 同时清空跨回合记忆
                _output.WriteLine("已清空屏幕与对话记忆");
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
