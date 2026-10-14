using System.Text.Json;
using Common.Events;
using Core.Llm;
using Core.Sessions;
using Core.Skills;
using Di.Cli;
using Di.Cli.Modes;

namespace Di.Cli.Tests.Modes;

/// <summary>
/// <see cref="PrintMode"/>（headless 单发）的单元测试。
/// 用 fake 宿主（真实事件总线 + 假会话驱动 + 假模型目录）验证：
/// 提示词来源（位置参数 / stdin）、文本流式渲染、JSON 单文档输出、
/// 会话日志写入 / --no-session 跳过、以及悲观的失败路径（空提示词、模型异常、StopReason.Error）。
/// </summary>
public sealed class PrintModeTests
{
    [Fact]
    public async Task Print_WithPositionalPrompt_RendersAnswer_ExitsZero()
    {
        var (host, runner) = Host();
        var stdout = new StringWriter();
        var stderr = new StringWriter();

        var code = await PrintMode.RunAsync(host, new CliArgs { Positionals = ["读一下 README"] },
            TextReader.Null, stdout, stderr);

        Assert.Equal(0, code);
        Assert.Equal(["读一下 README"], runner.Messages);
        var text = stdout.ToString();
        Assert.Contains("第 1 轮思考完成", text);      // 事件经总线流式渲染
        Assert.Contains("回答: 读一下 README", text);   // 最终回答（流式增量即答案）
        Assert.Equal("", stderr.ToString());
    }

    [Fact]
    public async Task Print_ReadsPromptFromStdin_WhenNoPositional()
    {
        var (host, runner) = Host();
        var stdout = new StringWriter();
        var stderr = new StringWriter();

        var code = await PrintMode.RunAsync(host, new CliArgs(), new StringReader("从管道来的提示词"), stdout, stderr);

        Assert.Equal(0, code);
        Assert.Equal(["从管道来的提示词"], runner.Messages);
    }

    [Fact]
    public async Task Print_MultiplePositionals_JoinedWithSpace()
    {
        var (host, runner) = Host();
        var stdout = new StringWriter();

        var code = await PrintMode.RunAsync(host, new CliArgs { Positionals = ["读", "README", "前", "十行"] },
            TextReader.Null, stdout, new StringWriter());

        Assert.Equal(0, code);
        Assert.Equal(["读 README 前 十行"], runner.Messages);
    }

    [Fact]
    public async Task Print_EmptyPrompt_ExitsOne_WritesError_DoesNotRunTurn()
    {
        var (host, runner) = Host();
        var stdout = new StringWriter();
        var stderr = new StringWriter();

        var code = await PrintMode.RunAsync(host, new CliArgs(), TextReader.Null, stdout, stderr);

        Assert.Equal(1, code);
        Assert.Empty(runner.Messages);
        Assert.Contains("缺少提示词", stderr.ToString());
        Assert.Equal("", stdout.ToString());
    }

    [Fact]
    public async Task Print_ModelFlag_OverridesCurrentModel()
    {
        var (host, runner) = Host();
        var stdout = new StringWriter();

        var code = await PrintMode.RunAsync(host, new CliArgs { Model = "deepseek-v4-pro", Positionals = ["hi"] },
            TextReader.Null, stdout, new StringWriter());

        Assert.Equal(0, code);
        Assert.Equal("deepseek-v4-pro", runner.CurrentModel);
    }

    [Fact]
    public async Task Print_StdoutTty_ShowsWorkingStatusBeforeFirstOutput()
    {
        var (host, _) = Host();
        var stdout = new StringWriter();

        var code = await PrintMode.RunAsync(host, new CliArgs { Positionals = ["hi"] },
            TextReader.Null, stdout, new StringWriter(), stdoutTty: true);

        Assert.Equal(0, code);
        var text = stdout.ToString();
        // 真实终端（stdout 未重定向）等待模型首 token 期间有"正在请求模型…"反馈，
        // 且必须出现在首个回合输出（第 1 轮思考完成）之前。
        Assert.Contains("正在请求模型", text);
        Assert.True(
            text.IndexOf("正在请求模型", StringComparison.Ordinal)
                < text.IndexOf("第 1 轮思考完成", StringComparison.Ordinal),
            "状态行应先于首个回合输出出现");
    }

    [Fact]
    public async Task Print_StdoutRedirected_OmitsWorkingStatus()
    {
        var (host, _) = Host();
        var stdout = new StringWriter();

        // stdoutTty 缺省 false（管道 / 文件 / 脚本）：不得输出状态行污染捕获内容。
        var code = await PrintMode.RunAsync(host, new CliArgs { Positionals = ["hi"] },
            TextReader.Null, stdout, new StringWriter());

        Assert.Equal(0, code);
        Assert.DoesNotContain("正在请求模型", stdout.ToString());
    }

    [Fact]
    public async Task Print_RunnerThrows_ExitsOne_WritesErrorToStderr()
    {
        var bus = new InMemoryEventBus();
        var host = new CliHost(new ThrowingRunner(), bus, new FakeLlm([]), [], new ReplOptions(), null);
        var stdout = new StringWriter();
        var stderr = new StringWriter();

        var code = await PrintMode.RunAsync(host, new CliArgs { Positionals = ["hi"] }, TextReader.Null, stdout, stderr);

        Assert.Equal(1, code);
        Assert.Contains("运行失败", stderr.ToString());
    }

    [Fact]
    public async Task Print_StopReasonError_ExitsOne_WritesCodeAndMessage()
    {
        var bus = new InMemoryEventBus();
        var runner = new ErrorRunner { Bus = bus };
        var host = new CliHost(runner, bus, new FakeLlm([]), [], new ReplOptions(), null);
        var stdout = new StringWriter();
        var stderr = new StringWriter();

        var code = await PrintMode.RunAsync(host, new CliArgs { Positionals = ["hi"] }, TextReader.Null, stdout, stderr);

        Assert.Equal(1, code);
        Assert.Contains("missing_credential", stderr.ToString());
        Assert.Contains("缺少 API Key", stderr.ToString());
    }

    [Fact]
    public async Task Print_WritesSessionLog_ByDefault()
    {
        var root = Directory.CreateTempSubdirectory("di-print-session-").FullName;
        try
        {
            var (host, _) = Host(root: root);
            var stdout = new StringWriter();

            var code = await PrintMode.RunAsync(host, new CliArgs { Positionals = ["hi"] },
                TextReader.Null, stdout, new StringWriter());

            Assert.Equal(0, code);
            Assert.True(File.Exists(host.SessionLog!.LogFilePath));
            var lines = File.ReadAllLines(host.SessionLog.LogFilePath)
                .Where(l => !string.IsNullOrWhiteSpace(l)).ToArray();
            using var meta = JsonDocument.Parse(lines[0]);
            Assert.Equal("session_meta", meta.RootElement.GetProperty("type").GetString());
            using var complete = JsonDocument.Parse(lines[^1]);
            Assert.Equal("task_complete",
                complete.RootElement.GetProperty("payload").GetProperty("type").GetString());
            Assert.True(lines.Length >= 4, "单发回合至少写 meta + task_started + turn_context + task_complete");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task Print_NoSession_SkipsWritingLog()
    {
        var root = Directory.CreateTempSubdirectory("di-print-nosession-").FullName;
        try
        {
            var (host, _) = Host(root: root);
            var stdout = new StringWriter();

            var code = await PrintMode.RunAsync(host, new CliArgs { Positionals = ["hi"], NoSession = true },
                TextReader.Null, stdout, new StringWriter());

            Assert.Equal(0, code);
            Assert.False(File.Exists(host.SessionLog!.LogFilePath), "--no-session 不应创建会话文件");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    // ---- JSON ----

    [Fact]
    public async Task Json_EmitsParseableDoc_WithAnswerStopReasonIterationsUsage_ExitsZero()
    {
        var (host, _) = Host();
        var stdout = new StringWriter();
        var stderr = new StringWriter();

        var code = await PrintMode.RunAsync(host, new CliArgs { Mode = "json", Positionals = ["分析"] },
            TextReader.Null, stdout, stderr);

        Assert.Equal(0, code);
        using var doc = JsonDocument.Parse(stdout.ToString());
        Assert.Equal("回答: 分析", doc.RootElement.GetProperty("answer").GetString());
        Assert.Equal("answer", doc.RootElement.GetProperty("stop_reason").GetString());
        Assert.Equal(1, doc.RootElement.GetProperty("iterations").GetInt32());
        var usage = doc.RootElement.GetProperty("usage");
        Assert.Equal(10, usage.GetProperty("input_tokens").GetInt32());
        Assert.Equal(20, usage.GetProperty("output_tokens").GetInt32());
        Assert.Equal("", stderr.ToString());
    }

    [Fact]
    public async Task Json_CostNull_OmittedFromDoc()
    {
        var (host, _) = Host();   // FakeRunner.Cost 默认 null
        var stdout = new StringWriter();

        await PrintMode.RunAsync(host, new CliArgs { Mode = "json", Positionals = ["hi"] },
            TextReader.Null, stdout, new StringWriter());

        using var doc = JsonDocument.Parse(stdout.ToString());
        Assert.False(doc.RootElement.TryGetProperty("cost", out _), "cost 为 null 时应省略键，而非输出 null");
    }

    [Fact]
    public async Task Json_CostPresent_SerializedAsNumber()
    {
        var (host, _) = Host(cost: new UsageCost(0.1, 0.2, 0, 0));   // Total = 0.3
        var stdout = new StringWriter();

        await PrintMode.RunAsync(host, new CliArgs { Mode = "json", Positionals = ["hi"] },
            TextReader.Null, stdout, new StringWriter());

        using var doc = JsonDocument.Parse(stdout.ToString());
        Assert.Equal(0.3, doc.RootElement.GetProperty("cost").GetDouble(), precision: 10);
    }

    [Fact]
    public async Task Json_DoesNotStreamEvents_OnlySingleDoc()
    {
        var (host, _) = Host();
        var stdout = new StringWriter();

        await PrintMode.RunAsync(host, new CliArgs { Mode = "json", Positionals = ["hi"] },
            TextReader.Null, stdout, new StringWriter());

        var text = stdout.ToString();
        Assert.DoesNotContain("思考完成", text);   // JSON 模式不写人类可读事件
        Assert.DoesNotContain("\n", text.Trim());   // 且只输出一个 JSON 文档
    }

    // ---- skill 自动匹配（headless 与 REPL 同一共享计算） ----

    [Fact]
    public async Task Print_AutoActivatesMatchingSkill_SetsActiveSkills()
    {
        var (host, runner) = HostWithSkills();
        var stdout = new StringWriter();

        var code = await PrintMode.RunAsync(host, new CliArgs { Positionals = ["跑一下后端测试"] },
            TextReader.Null, stdout, new StringWriter());

        Assert.Equal(0, code);
        Assert.Equal(["backend-tests"], runner.ActiveSkills.Select(s => s.Name));
    }

    [Fact]
    public async Task Print_NoMatchingSkill_LeavesActiveSkillsEmpty()
    {
        var (host, runner) = HostWithSkills();
        var stdout = new StringWriter();

        var code = await PrintMode.RunAsync(host, new CliArgs { Positionals = ["随便聊聊"] },
            TextReader.Null, stdout, new StringWriter());

        Assert.Equal(0, code);
        Assert.Empty(runner.ActiveSkills);
    }

    [Fact]
    public async Task Json_AutoActivatesMatchingSkill_SetsActiveSkills()
    {
        var (host, runner) = HostWithSkills();
        var stdout = new StringWriter();

        var code = await PrintMode.RunAsync(host, new CliArgs { Mode = "json", Positionals = ["跑一下后端测试"] },
            TextReader.Null, stdout, new StringWriter());

        Assert.Equal(0, code);
        Assert.Equal(["backend-tests"], runner.ActiveSkills.Select(s => s.Name));
    }

    [Fact]
    public async Task Json_EmptyPrompt_EmitsErrorDoc_ExitsOne()
    {
        var (host, runner) = Host();
        var stdout = new StringWriter();
        var stderr = new StringWriter();

        var code = await PrintMode.RunAsync(host, new CliArgs { Mode = "json" }, TextReader.Null, stdout, stderr);

        Assert.Equal(1, code);
        Assert.Empty(runner.Messages);
        using var doc = JsonDocument.Parse(stdout.ToString());
        var error = doc.RootElement.GetProperty("error");
        Assert.Equal("usage", error.GetProperty("code").GetString());
        Assert.Contains("提示词", error.GetProperty("message").GetString());
    }

    [Fact]
    public async Task Json_RunnerThrows_EmitsErrorDoc_ExitsOne()
    {
        var bus = new InMemoryEventBus();
        var host = new CliHost(new ThrowingRunner(), bus, new FakeLlm([]), [], new ReplOptions(), null);
        var stdout = new StringWriter();

        var code = await PrintMode.RunAsync(host, new CliArgs { Mode = "json", Positionals = ["hi"] },
            TextReader.Null, stdout, new StringWriter());

        Assert.Equal(1, code);
        using var doc = JsonDocument.Parse(stdout.ToString());
        Assert.Equal("model_error", doc.RootElement.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Json_StopReasonError_EmitsErrorCode_ExitsOne()
    {
        var bus = new InMemoryEventBus();
        var runner = new ErrorRunner { Bus = bus };
        var host = new CliHost(runner, bus, new FakeLlm([]), [], new ReplOptions(), null);
        var stdout = new StringWriter();

        var code = await PrintMode.RunAsync(host, new CliArgs { Mode = "json", Positionals = ["hi"] },
            TextReader.Null, stdout, new StringWriter());

        Assert.Equal(1, code);
        using var doc = JsonDocument.Parse(stdout.ToString());
        var error = doc.RootElement.GetProperty("error");
        Assert.Equal("missing_credential", error.GetProperty("code").GetString());
        Assert.Contains("API Key", error.GetProperty("message").GetString());
    }

    [Fact]
    public async Task Json_WritesSessionLog_ByDefault()
    {
        var root = Directory.CreateTempSubdirectory("di-print-json-session-").FullName;
        try
        {
            var (host, _) = Host(root: root);
            var stdout = new StringWriter();

            var code = await PrintMode.RunAsync(host, new CliArgs { Mode = "json", Positionals = ["hi"] },
                TextReader.Null, stdout, new StringWriter());

            Assert.Equal(0, code);
            Assert.True(File.Exists(host.SessionLog!.LogFilePath), "json 模式默认也应写会话日志");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    // ---- 工具 ----

    private static (CliHost Host, FakeRunner Runner) Host(string? root = null, UsageCost? cost = null)
    {
        var bus = new InMemoryEventBus();
        var runner = new FakeRunner { Bus = bus, Cost = cost };
        var sessionLog = root is null ? null : new SessionLog(new SessionLogOptions { RootDirectory = root });
        return (new CliHost(runner, bus, new FakeLlm([]), [], new ReplOptions(), sessionLog), runner);
    }

    /// <summary>带一个可匹配 skill 的宿主（供 headless 自动匹配测试）。</summary>
    private static (CliHost Host, FakeRunner Runner) HostWithSkills()
    {
        var bus = new InMemoryEventBus();
        var runner = new FakeRunner { Bus = bus };
        var skill = new Skill
        {
            Name = "backend-tests",
            Description = "运行并修复后端测试（dotnet）。当用户要求运行测试、分析失败或修复测试时使用。",
            Instructions = "1. dotnet build\n2. dotnet test",
        };
        return (new CliHost(runner, bus, new FakeLlm([]), [skill], new ReplOptions(), null), runner);
    }
}
