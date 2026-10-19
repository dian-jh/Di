using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Common.Events;
using Core.AgentLoop;
using Core.Skills;

namespace Di.Cli.Modes;

/// <summary>
/// Headless 单发模式（对应 Pi 的 print 模式）：跑一个回合就退出。
/// 文本（默认 / --mode print）：事件流式渲染到 stdout（禁用 ANSI；TTY 下回合开始时先显示
/// <c>正在请求模型…</c> 状态行，首个输出到达后不再出现——管道/重定向时省略，保持捕获输出干净）；
/// JSON（--mode json）：回合结束输出<b>单个</b> JSON 文档（脚本友好）。
/// 提示词 = 位置参数拼接，无位置参数时从 stdin 读到 EOF。
/// 失败路径（空提示词 / 模型异常 / StopReason.Error）→ 退出码 1；默认写会话日志（--no-session 关闭）。
/// </summary>
public static class PrintMode
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        // stdout 输出存原生 UTF-8 而非 \uXXXX 转义（与 SessionLog 同款）：终端可读、体积小。
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static async Task<int> RunAsync(CliHost host, CliArgs args, TextReader stdin, TextWriter stdout,
        TextWriter stderr, bool stdoutTty = false, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(host);
        ArgumentNullException.ThrowIfNull(args);
        ArgumentNullException.ThrowIfNull(stdin);
        ArgumentNullException.ThrowIfNull(stdout);
        ArgumentNullException.ThrowIfNull(stderr);

        // 提示词：位置参数优先；没有则从 stdin 读到 EOF（管道/重定向场景）。
        var prompt = args.Positionals.Count > 0
            ? string.Join(' ', args.Positionals)
            : (await stdin.ReadToEndAsync(cancellationToken)).Trim();

        if (string.IsNullOrWhiteSpace(prompt))
        {
            const string message = "缺少提示词：给一个位置参数（di \"提示词\"）或从 stdin 传入（echo ... | di）";
            if (args.Mode == "json")
                await WriteErrorJsonAsync(stdout, "usage", message, cancellationToken);
            else
                await stderr.WriteLineAsync(message);
            return 1;
        }

        // --model 覆盖当前模型（headless 单发没有 /model 切换，必须在启动时定好）。
        if (args.Model is { } model)
            host.Runner.CurrentModel = model;

        return args.Mode == "json"
            ? await RunJsonAsync(host, args, prompt, stdout, stderr, cancellationToken)
            : await RunTextAsync(host, args, prompt, stdout, stderr, stdoutTty, cancellationToken);
    }

    /// <summary>文本：事件流式渲染（实时写出，模型生成即显示）。</summary>
    private static async Task<int> RunTextAsync(CliHost host, CliArgs args, string prompt,
        TextWriter stdout, TextWriter stderr, bool stdoutTty, CancellationToken cancellationToken)
    {
        using var consumer = host.Bus.CreateConsumer<AgentLoopEvent>();
        using var renderCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        // 思考增量只在真实终端渲染（消除思考期死屏：模型先流 ~1s reasoning 再流回答）；
        // 管道/重定向不渲染，保持捕获输出干净（与状态行同一原则）。
        var renderer = new EventRenderer(stdout, useAnsi: false, renderReasoning: stdoutTty);
        var renderTask = RenderAsync(consumer, renderer, renderCts.Token);

        var startedAt = DateTimeOffset.UtcNow;
        StartSession(host, args, stderr);
        ApplySkills(host, prompt);

        // 真实终端（stdoutTty）等待模型首 token 期间显示"正在请求模型…"（与 REPL 同款文案，
        // 见 ReplOptions.WorkingStatusText），首个事件到达即被清除；管道/重定向省略，避免污染捕获输出。
        if (stdoutTty)
            renderer.ShowStatus("⟳ 正在请求模型…");

        AgentResult result;
        try
        {
            result = await host.Runner.RunAsync(prompt, cancellationToken);
        }
        catch (Exception ex)
        {
            renderCts.Cancel();
            await StopRendererAsync(renderTask);
            await stderr.WriteLineAsync($"✗ 运行失败: {ex.Message}");
            return 1;
        }

        renderCts.Cancel();
        await StopRendererAsync(renderTask);

        // 兜底：取消瞬间渲染任务未消费的残余事件（发布同步入队，不会丢失）。
        while (consumer.TryRead() is { } evt)
            renderer.Render(evt);

        if (result.StopReason == AgentStopReason.Error)
        {
            var failure = result.Failure;
            await stderr.WriteLineAsync($"✗ 失败: [{failure?.Code}] {failure?.Message ?? result.Answer}");
            return 1;
        }

        AppendTurn(host, args, result, startedAt, stderr);
        renderer.RenderResult(result);
        return 0;
    }

    /// <summary>JSON：不流式，回合结束输出单个 JSON 文档（answer/stop_reason/iterations/usage/cost 可空省略）。</summary>
    private static async Task<int> RunJsonAsync(CliHost host, CliArgs args, string prompt,
        TextWriter stdout, TextWriter stderr, CancellationToken cancellationToken)
    {
        var startedAt = DateTimeOffset.UtcNow;
        StartSession(host, args, stderr);
        ApplySkills(host, prompt);

        AgentResult result;
        try
        {
            result = await host.Runner.RunAsync(prompt, cancellationToken);
        }
        catch (Exception ex)
        {
            await WriteErrorJsonAsync(stdout, "model_error", ex.Message, cancellationToken);
            return 1;
        }

        if (result.StopReason == AgentStopReason.Error)
        {
            var failure = result.Failure;
            await WriteErrorJsonAsync(stdout, failure?.Code ?? "model_error",
                failure?.Message ?? "模型调用失败", cancellationToken);
            return 1;
        }

        AppendTurn(host, args, result, startedAt, stderr);

        var doc = new Dictionary<string, object?>
        {
            ["answer"] = result.Answer,
            ["stop_reason"] = result.StopReason switch
            {
                AgentStopReason.ContextLimit => "context_limit",
                _ => result.StopReason.ToString().ToLowerInvariant(),
            },
            ["iterations"] = result.Iterations,
            ["usage"] = new { input_tokens = result.Usage.InputTokens, output_tokens = result.Usage.OutputTokens },
        };
        if (result.Cost is { } cost)
            doc["cost"] = cost.Total;

        await stdout.WriteLineAsync(JsonSerializer.Serialize(doc, Json));
        return 0;
    }

    /// <summary>实时消费事件流并渲染（与 Repl 同一模式）。</summary>
    private static async Task RenderAsync(IEventConsumer<AgentLoopEvent> consumer, EventRenderer renderer,
        CancellationToken cancellationToken)
    {
        await foreach (var evt in consumer.ConsumeAsync(cancellationToken))
        {
            try
            {
                renderer.Render(evt);
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

    /// <summary>会话日志尽力而为：启动失败只告警，不改变退出码。--no-session 时整体跳过。</summary>
    private static void StartSession(CliHost host, CliArgs args, TextWriter stderr)
    {
        if (args.NoSession)
            return;
        try
        {
            host.SessionLog?.StartSession();
        }
        catch (Exception ex)
        {
            stderr.WriteLine($"⚠ 会话日志初始化失败: {ex.Message}");
        }
    }

    /// <summary>回合结束落盘（尽力而为）。--no-session 时整体跳过。</summary>
    private static void AppendTurn(CliHost host, CliArgs args, AgentResult result,
        DateTimeOffset startedAt, TextWriter stderr)
    {
        if (args.NoSession)
            return;
        try
        {
            host.SessionLog?.AppendTurn(result, startedAt);
        }
        catch (Exception ex)
        {
            stderr.WriteLine($"⚠ 会话日志写入失败: {ex.Message}");
        }
    }

    /// <summary>
    /// headless 单发也做 skill 自动匹配（与 REPL 同一共享计算 <see cref="SkillActivation"/>）：
    /// 同一条提示词激活同一批 skill。匹配结果写入 runner，AgentRunner 据此把激活 skill 的
    /// 完整指令注入系统上下文（渐进式披露；未激活的仍只广告，模型可 load_skill）。
    /// </summary>
    private static void ApplySkills(CliHost host, string prompt)
    {
        var activation = SkillActivation.Compute(prompt, host.Skills, [], new LexicalSkillMatcher());
        host.Runner.ActiveSkills = activation.Active;
    }

    /// <summary>JSON 错误文档：{"error": {"code": ..., "message": ...}}（脚本可解析）。</summary>
    private static Task WriteErrorJsonAsync(TextWriter stdout, string code, string message,
        CancellationToken cancellationToken)
    {
        var doc = new { error = new { code, message } };
        return stdout.WriteLineAsync(JsonSerializer.Serialize(doc, Json));
    }
}
