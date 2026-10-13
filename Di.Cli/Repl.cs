using Common.Events;
using Core.AgentLoop;
using Core.Sessions;
using Core.Skills;
using Di.Cli.Commands;

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
    private readonly IReadOnlyList<Skill> _skills;
    private readonly ISkillMatcher _matcher;
    private readonly InterruptCoordinator? _interrupt;
    private readonly SlashCommandRegistry _registry;

    /// <summary>固定激活的 skills（/skill 手动设置，跨回合保持）。自动匹配的结果是每回合临时算的，不存这里。</summary>
    private readonly List<Skill> _pinned = [];

    public Repl(IAgentRunner runner, IEventBus bus, ILineReader reader, TextWriter output, ReplOptions options,
        SessionLog? sessionLog = null, IReadOnlyList<Skill>? skills = null, ISkillMatcher? matcher = null,
        InterruptCoordinator? interrupt = null, SlashCommandRegistry? commands = null)
    {
        _runner = runner ?? throw new ArgumentNullException(nameof(runner));
        _bus = bus ?? throw new ArgumentNullException(nameof(bus));
        _reader = reader ?? throw new ArgumentNullException(nameof(reader));
        _output = output ?? throw new ArgumentNullException(nameof(output));
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _renderer = new EventRenderer(output, options.UseAnsi);
        _sessionLog = sessionLog;
        _skills = skills ?? [];
        _matcher = matcher ?? new LexicalSkillMatcher();
        _interrupt = interrupt;
        _registry = commands ?? BuiltinCommands.CreateRegistry();
    }

    public async Task RunAsync(CancellationToken cancellationToken = default)
    {
        // 把软停止信号接到 runner（会话级）：Ctrl+C 第一次请求软停止，ReAct 在相位边界轮询它。
        // 与 CurrentModel / ActiveSkills 同款——由前端持有并注入，harness 只读。
        if (_interrupt is not null)
            _runner.InterruptSignal = _interrupt;

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
                if (await RunCommandAsync(line, cancellationToken))
                    break;   // /exit
                continue;
            }

            await RunTurnAsync(line, cancellationToken);
        }
    }

    /// <summary>
    /// 一次聊天回合：先建消费者，启动并发渲染任务（实时消费事件流），
    /// 运行结束后取消渲染任务并兜底排空残余事件，最后打印脚注。
    /// 回合级中断（roadmap §3 缺口 #3）：本回合的取消源注册到 <see cref="InterruptCoordinator"/>，
    /// 第一次 Ctrl+C 只取消当前回合（保留已写入会话），第二次才退出进程。
    /// </summary>
    private async Task RunTurnAsync(string userMessage, CancellationToken cancellationToken)
    {
        // 回合级取消源：链接外层（生命周期）token；Ctrl+C 第一次只取消它，不取消整个进程。
        using var turnCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _interrupt?.BeginTurn(turnCts);
        try
        {
            using var consumer = _bus.CreateConsumer<AgentLoopEvent>();
            var renderTask = RenderAsync(consumer, turnCts.Token);

            // 自动匹配：按本条消息与 skill 描述的语义相关度加载未固定的 skill（共享计算，headless 同款）。
            // 固定集（/skill 手动激活）不受影响，二者可叠加；匹配结果每回合重算，不累积。
            var activation = SkillActivation.Compute(userMessage, _skills, _pinned, _matcher);
            _runner.ActiveSkills = activation.Active;
            if (activation.AutoMatched.Count > 0)
                _output.WriteLine("⟦ 自动加载 skill：" + string.Join("、", activation.AutoMatched.Select(s => s.Name)) + "⟧");

            // 模型首个输出可能延迟数秒（网络/思考），先给出可见反馈，首个事件到达时被擦除。
            _renderer.ShowStatus(_options.WorkingStatusText);

            var startedAt = DateTimeOffset.UtcNow;   // 记录到会话日志，用于计算 duration_ms

            AgentResult result;
            try
            {
                result = await _runner.RunAsync(userMessage, turnCts.Token);
            }
            catch (OperationCanceledException)
            {
                // 回合被取消（Ctrl+C）：清指示器、停渲染，提示后回到外层循环；不追加会话（回合未完成）。
                _renderer.ClearStatus();
                _output.WriteLine("  ⏹ 回合已取消");
                turnCts.Cancel();
                await StopRendererAsync(renderTask);
                return;
            }
            catch (Exception ex)
            {
                _renderer.ClearStatus();
                _output.WriteLine($"  ✗ 运行失败: {ex.Message}");
                turnCts.Cancel();
                await StopRendererAsync(renderTask);
                // 失败回合也落盘（尽力而为）：否则异常回合在会话文件里"查无此证"，无法复盘。
                try
                {
                    _sessionLog?.AppendFailure(userMessage, ex.Message, startedAt);
                }
                catch (Exception logEx)
                {
                    _output.WriteLine($"  ⚠ 会话日志写入失败: {logEx.Message}");
                }
                return;
            }

            turnCts.Cancel();
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
        finally
        {
            _interrupt?.EndTurn(turnCts);   // 回合结束：注销当前回合的取消源
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

    /// <summary>
    /// 斜杠命令；返回 true 表示退出。走注册表分发（内置 <see cref="BuiltinCommands"/> + 用户命令）；
    /// 回合型命令（返回值带 <see cref="CommandResult.TurnMessage"/>，如 /skill 带参数）由本 REPL 的
    /// 回合机制执行 —— 命令本身不依赖任何前端，REPL 与 RPC/TUI 共用同一批命令定义。
    /// </summary>
    private async Task<bool> RunCommandAsync(string command, CancellationToken cancellationToken)
    {
        var (slashName, args) = SlashCommandRegistry.Split(command);
        var name = slashName.TrimStart('/');

        if (!_registry.TryGet(name, out var cmd) || cmd is null)
        {
            _output.WriteLine($"未知命令: /{name}（输入 /help 查看帮助）");
            return false;
        }

        var context = new CommandContext(_registry, _runner, _skills, _output, _pinned,
            UseAnsi: _options.UseAnsi, RunTurn: RunTurnAsync, CancellationToken: cancellationToken);

        var result = await cmd.Handler(args, context);
        if (result.TurnMessage is { Length: > 0 } message)
            await RunTurnAsync(message, cancellationToken);
        return result.Exit;
    }
}
