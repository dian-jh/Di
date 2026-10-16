using Core.AgentLoop;
using Core.Llm;
using Core.Skills;
using Di.Cli.Commands;

namespace Di.Cli.Tests.Commands;

/// <summary>
/// 内置命令（对齐 Pi 的 SlashCommandContribution）经 <see cref="CommandContext"/> 的行为测试。
/// 与 REPL 共享同一注册内容：端到端回归由 <c>ReplTests</c> 保障（此处测命令本身）。
/// </summary>
public sealed class BuiltinCommandsTests
{
    private static readonly Skill TestSkill = new()
    {
        Name = "backend-tests",
        Description = "跑后端测试",
        Instructions = "dotnet test",
    };

    private readonly TrackingRunner _runner = new();
    private readonly List<Skill> _pinned = [];
    private readonly List<string> _turns = [];
    private readonly SlashCommandRegistry _registry = BuiltinCommands.CreateRegistry();
    private readonly StringWriter _buffer = new();

    private CommandContext Ctx() =>
        new(_registry, _runner, [TestSkill], _buffer, _pinned, UseAnsi: true,
            RunTurn: (msg, _) => { _turns.Add(msg); return Task.CompletedTask; },
            Models: new ModelSelection(new FakeLlm([new LlmModelInfo("deepseek", "deepseek-chat", "DeepSeek Chat")]), _runner));

    private SlashCommand Cmd(string name)
    {
        Assert.True(_registry.TryGet(name, out var cmd), $"命令 /{name} 应已注册");
        return cmd!;
    }

    [Fact]
    public async Task All_Builtins_Registered()
    {
        Assert.Equal(["clear", "exit", "help", "model", "skill", "skills", "thinking", "usage"],
            _registry.List().Select(c => c.Name));
    }

    [Fact]
    public async Task Exit_RequestsQuit_NoTurn()
    {
        var result = await Cmd("exit").Handler("", Ctx());

        Assert.True(result.Exit);
        Assert.Null(result.TurnMessage);
        Assert.Empty(_turns);
    }

    [Fact]
    public async Task Help_Text_DerivedFromRegistry()
    {
        await Cmd("help").Handler("", Ctx());

        var text = _buffer.ToString();
        Assert.Contains("可用命令", text);
        Assert.Contains("/model [provider/model | 名称 | --refresh] —— 查看或切换模型", text);
        Assert.Contains("/exit —— 退出 Di", text);
    }

    [Fact]
    public async Task Clear_ResetsHistory_AndClearsScreenWithAnsi()
    {
        var ctx = new CommandContext(_registry, _runner, [], _buffer, [], UseAnsi: true);

        var result = await Cmd("clear").Handler("", ctx);

        Assert.Equal(CommandResult.Handled, result);
        Assert.Equal(1, _runner.ResetCalls);
        Assert.Contains("\x1b[2J", _buffer.ToString());
    }

    [Fact]
    public async Task Clear_NoAnsi_OmitsEscapeSequences()
    {
        var ctx = new CommandContext(_registry, _runner, [], _buffer, [], UseAnsi: false);

        await Cmd("clear").Handler("", ctx);

        Assert.Equal(1, _runner.ResetCalls);
        Assert.DoesNotContain("\x1b[", _buffer.ToString());
        Assert.Contains("已清空屏幕与对话记忆", _buffer.ToString());
    }

    [Fact]
    public async Task Model_WithArgs_SwitchesModel()
    {
        await Cmd("model").Handler("deepseek-chat", Ctx());

        Assert.Equal("deepseek-chat", _runner.CurrentModel);
        Assert.Contains("模型已切换为 deepseek-chat", _buffer.ToString());
    }

    [Fact]
    public async Task Model_WithoutArgs_ShowsUsage_ModelUnchanged()
    {
        await Cmd("model").Handler("", Ctx());

        Assert.Equal("deepseek-flash", _runner.CurrentModel);
        Assert.Contains("用法: /model", _buffer.ToString());
    }

    [Fact]
    public async Task Skills_ListsPinnedWithMarker()
    {
        _pinned.Add(TestSkill);

        await Cmd("skills").Handler("", Ctx());

        Assert.Contains("[*] backend-tests —— 跑后端测试", _buffer.ToString());
    }

    [Fact]
    public async Task Skills_Empty_ShowsHint()
    {
        var ctx = new CommandContext(_registry, _runner, [], _buffer, [], UseAnsi: true);

        await Cmd("skills").Handler("", ctx);

        Assert.Contains("没有可用 skill", _buffer.ToString());
    }

    [Fact]
    public async Task Skill_TogglePins_Then_Unpins()
    {
        await Cmd("skill").Handler("backend-tests", Ctx());
        Assert.Contains(TestSkill, _pinned);
        Assert.Equal(["backend-tests"], _runner.ActiveSkills.Select(s => s.Name));

        await Cmd("skill").Handler("backend-tests", Ctx());
        Assert.DoesNotContain(TestSkill, _pinned);
        Assert.Empty(_runner.ActiveSkills);
    }

    [Fact]
    public async Task Skill_Off_ClearsAll()
    {
        _pinned.Add(TestSkill);

        await Cmd("skill").Handler("off", Ctx());

        Assert.Empty(_pinned);
        Assert.Empty(_runner.ActiveSkills);
        Assert.Contains("已停用全部 skill", _buffer.ToString());
    }

    [Fact]
    public async Task Skill_Unknown_ReportsNotFound()
    {
        await Cmd("skill").Handler("nope", Ctx());

        Assert.Contains("未找到 skill：nope", _buffer.ToString());
    }

    [Fact]
    public async Task Skill_WithArgs_RunsTurn_WithoutPinning()
    {
        var result = await Cmd("skill").Handler("backend-tests 帮我补测试", Ctx());

        Assert.False(result.Exit);
        Assert.NotNull(result.TurnMessage);
        Assert.Contains("【Skill：backend-tests】", result.TurnMessage);
        Assert.Contains("dotnet test", result.TurnMessage);
        Assert.Contains("帮我补测试", result.TurnMessage);
        Assert.DoesNotContain(TestSkill, _pinned);   // 一次性执行不固定
        Assert.Empty(_turns);                        // 回合由宿主执行，命令本身不跑
    }

    /// <summary>记录 ResetHistory / 模型切换 / ActiveSkills 的假驱动。</summary>
    private sealed class TrackingRunner : IAgentRunner
    {
        public string CurrentModel { get; set; } = "deepseek-flash";
        public IReadOnlyList<Skill> ActiveSkills { get; set; } = [];

        public IInterruptSignal? InterruptSignal { get; set; }
        public int ResetCalls { get; private set; }
        public void ResetHistory() => ResetCalls++;

        public Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default)
            => Task.FromResult(new AgentResult
            {
                Answer = "",
                Trajectory = [],
                Iterations = 0,
                StopReason = AgentStopReason.Answer,
            });
    }
}
