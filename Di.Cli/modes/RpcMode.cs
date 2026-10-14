using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Common.Events;
using Core.AgentLoop;
using Core.Llm;
using Core.Skills;
using Di.Cli.Commands;

namespace Di.Cli.Modes;

/// <summary>
/// RPC 模式（--mode rpc）：NDJSON over stdin/stdout 的会话驱动后端（docs/tui-rpc.md 是线协议唯一权威）。
/// TS TUI 以子进程方式驱动 <see cref="CliHost"/>：stdin 逐行读请求，stdout 逐行写
/// ready / event / result / error（每行立即 flush，实时流式）。
///
/// 语义要点：
/// <list type="bullet">
/// <item>组合根构建完成先发一次 <c>ready</c>，TUI 等到 ready 后才开始发请求。</item>
/// <item>请求串行处理；<c>prompt</c> 在后台跑回合，主循环继续读行 —— 这样 <c>interrupt</c> /
///   <c>shutdown</c> 能在回合进行中到达（stdin 是管道，无 Console.CancelKeyPress）。</item>
/// <item>回合内失败是消息不是崩溃：<c>run_failed</c> 事件或 <c>result.stop_reason:"error"</c>；
///   协议解析失败发 <c>error</c> 后继续；stdin EOF → 结束当前回合后退出 0。</item>
/// <item>序列化与 PrintMode / SessionLog 同款：snake_case、null 键省略、宽松 UTF-8 转义。</item>
/// </list>
/// </summary>
public static class RpcMode
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        // 与 PrintMode / SessionLog 同款：stdout 存原生 UTF-8 而非 \uXXXX 转义（TUI 直接按行读）。
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static async Task<int> RunAsync(CliHost host, CliArgs args, TextReader stdin, TextWriter stdout,
        TextWriter stderr, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(host);
        ArgumentNullException.ThrowIfNull(args);
        ArgumentNullException.ThrowIfNull(stdin);
        ArgumentNullException.ThrowIfNull(stdout);
        ArgumentNullException.ThrowIfNull(stderr);

        // 主循环与后台回合任务都可能写 stdout：同一把锁串行化，保证线序 = 序号一致、无交错。
        var writeLock = new object();

        // 组合根已构建、可服务请求：先握手（仅一次）。携带当前模型 / 强度 / skills / 模型目录快照，
        // TUI 据此渲染右下角状态栏并对齐命令补全（docs/tui-rpc.md §2.1）。
        WriteLine(stdout, writeLock, Serialize(new
        {
            type = "ready",
            version = "0.1.0",
            model = host.Runner.CurrentModel,
            effort = host.ReasoningEffort,
            skills = host.Skills.Select(s => new { name = s.Name, description = s.Description }),
            models = host.Llm.ListModels().Select(m => new { id = m.Id, name = m.Name }),
        }));

        // 会话开始写首行 session_meta（尽力而为；--no-session 时跳过）。
        if (!args.NoSession)
        {
            try { host.SessionLog?.StartSession(); }
            catch (Exception ex) { stderr.WriteLine($"⚠ 会话日志初始化失败: {ex.Message}"); }
        }

        Task? turnTask = null;
        CancellationTokenSource? turnCts = null;

        // 命令系统（docs/tui-rpc.md §3 command）：注册表来自宿主（内置 + 用户命令）；
        // 固定 skill 集在会话内跨命令保持（/skill 激活、/skills 标记）。
        var pinnedSkills = new List<Skill>();

        try
        {
            while (true)
            {
                var line = await stdin.ReadLineAsync(cancellationToken);
                if (line is null)
                    break;   // stdin EOF：结束当前回合后退出 0

                RpcRequest request;
                try
                {
                    request = ParseRequest(line);
                }
                catch (Exception ex)
                {
                    WriteLine(stdout, writeLock, Serialize(new { type = "error", code = "parse_error", message = ex.Message }));
                    continue;
                }

                switch (request.Method)
                {
                    case "prompt":
                        // 串行：先完成上一回合（协议要求 TUI 等 result 后再发下一条，此处只是防御）。
                        await FinishTurnAsync(turnTask);
                        turnCts?.Dispose();
                        if (request.Params is not { } p || p["message"] is not { } msg
                            || msg.GetValueKind() != JsonValueKind.String)
                        {
                            turnCts = null;
                            turnTask = null;
                            WriteLine(stdout, writeLock, Serialize(new { type = "error", code = "invalid_request", message = "prompt 缺少 message 字符串参数" }));
                            break;
                        }
                        // 回合级取消源（对齐 InterruptCoordinator 的 per-turn CTS 模式）：
                        // interrupt 请求只取消它，不取消整个进程生命周期。
                        turnCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                        turnTask = RunTurnAsync(host, args, msg.GetValue<string>(), stdout, stderr, writeLock, turnCts.Token);
                        break;

                    case "interrupt":
                        turnCts?.Cancel();   // 取消当前回合 → 对应 result.stop_reason:"cancelled"
                        break;

                    case "set_model":
                        if (request.Params is not { } pm || pm["model"] is not { } model
                            || model.GetValueKind() != JsonValueKind.String)
                        {
                            WriteLine(stdout, writeLock, Serialize(new { type = "error", code = "invalid_request", message = "set_model 缺少 model 字符串参数" }));
                            break;
                        }
                        host.Runner.CurrentModel = model.GetValue<string>();
                        break;

                    case "set_skills":
                        if (request.Params is not { } ps || ps["names"] is not { } names
                            || names.GetValueKind() != JsonValueKind.Array)
                        {
                            WriteLine(stdout, writeLock, Serialize(new { type = "error", code = "invalid_request", message = "set_skills 缺少 names 字符串数组参数" }));
                            break;
                        }
                        var wanted = names.AsArray()
                            .Where(n => n is not null && n.GetValueKind() == JsonValueKind.String)
                            .Select(n => n!.GetValue<string>())
                            .ToHashSet(StringComparer.Ordinal);
                        // 只接受宿主已发现的 skill（未知名静默忽略，避免把任意字符串塞给 runner）。
                        host.Runner.ActiveSkills = host.Skills.Where(s => wanted.Contains(s.Name)).ToArray();
                        break;

                    case "clear_history":
                        host.Runner.ResetHistory();
                        break;

                    case "command":
                        await HandleCommandAsync(host, pinnedSkills, request, stdout, writeLock);
                        break;

                    case "ping":
                        break;   // 心跳，无应答

                    case "shutdown":
                        await FinishTurnAsync(turnTask);
                        return 0;

                    default:
                        WriteLine(stdout, writeLock, Serialize(new { type = "error", code = "unknown_method", message = $"未知方法: {request.Method}" }));
                        break;
                }
            }

            // stdin EOF：结束当前回合后退出 0（回合是后台任务，result 已由其自行发出）。
            await FinishTurnAsync(turnTask);
            return 0;
        }
        finally
        {
            turnCts?.Dispose();
        }
    }

    /// <summary>等待后台回合任务结束（结果/错误已由回合自身发出）。异常兜底吞掉，不拖垮进程。</summary>
    private static async Task FinishTurnAsync(Task? turnTask)
    {
        if (turnTask is null)
            return;
        try { await turnTask; }
        catch (Exception) { /* 回合内部已尽力自处理，这里只确保不崩 */ }
    }

    /// <summary>
    /// command 请求（docs/tui-rpc.md §3）：<c>list</c> 列注册表（内置 + 用户命令），<c>run</c> 执行同步命令。
    /// 回合型命令（返回值带 <see cref="CommandResult.TurnMessage"/>，如 /skill 带参数、用户命令）
    /// → <c>command_error: turn_not_supported</c>：RPC 无回合执行器，TUI 用自身 prompt 机制跑回合，
    /// REPL 提供 RunTurn（命令定义本身与前端无关，同一份注册表）。
    /// </summary>
    private static async Task HandleCommandAsync(CliHost host, List<Skill> pinned, RpcRequest request,
        TextWriter stdout, object writeLock)
    {
        try
        {
            if (request.Params is not { } p)
                throw new FormatException("command 需要 params 对象");

            if (p.TryGetPropertyValue("list", out var listNode) && listNode?.GetValueKind() == JsonValueKind.True)
            {
                var entries = host.Commands.List()
                    .Select(c => new { name = c.Name, description = c.Description, argument_hint = c.ArgumentHint });
                WriteLine(stdout, writeLock, Serialize(new { type = "command_listed", commands = entries }));
                return;
            }

            if (p["name"] is not { } nameNode || nameNode.GetValueKind() != JsonValueKind.String)
                throw new FormatException("command run 需要 name 字符串参数");
            var name = nameNode.GetValue<string>();
            var args = p["args"] is { } a && a.GetValueKind() == JsonValueKind.String ? a.GetValue<string>() : string.Empty;

            if (!host.Commands.TryGet(name, out var cmd) || cmd is null)
            {
                WriteLine(stdout, writeLock, Serialize(new { type = "command_error", code = "unknown_command", message = $"未知命令: /{name}" }));
                return;
            }

            // 命令输出写进内存缓冲，随应答返回（stdout 是协议流，不允许命令直接写）。
            using var buffer = new StringWriter();
            var context = new CommandContext(host.Commands, host.Runner, host.Skills, buffer, pinned, UseAnsi: false);
            var result = await cmd.Handler(args, context);

            if (result.TurnMessage is { Length: > 0 })
            {
                // 回合型命令：错误载荷附带 turn_message（指令+参数全文），TUI 据此改用自身
                // prompt 机制跑回合（docs/tui-rpc.md §2.5 —— 命令定义与前端无关，同一份注册表）。
                WriteLine(stdout, writeLock, Serialize(new
                {
                    type = "command_error",
                    code = "turn_not_supported",
                    message = $"命令 /{name} 是回合型命令，TUI 应改用 prompt 执行（turn_message 已附指令全文）",
                    turn_message = result.TurnMessage,
                }));
                return;
            }

            // 应答携带执行后的模型 / 强度快照（/model 切换后 TUI 据此更新状态栏，不依赖解析中文提示）。
            WriteLine(stdout, writeLock, Serialize(new
            {
                type = "command_ran",
                name,
                lines = BufferLines(buffer),
                exit = result.Exit,
                model = host.Runner.CurrentModel,
                effort = host.ReasoningEffort,
            }));
        }
        catch (Exception ex) when (ex is FormatException)
        {
            WriteLine(stdout, writeLock, Serialize(new { type = "command_error", code = "invalid_request", message = ex.Message }));
        }
    }

    /// <summary>把命令输出缓冲转成行数组（去空行、去 \r；应答不含 ANSI，RPC 端 UseAnsi=false）。</summary>
    private static string[] BufferLines(StringWriter buffer)
        => buffer.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => l.TrimEnd('\r')).ToArray();

    /// <summary>
    /// 运行一个回合：实时转发事件到 stdout，回合终结时发出唯一一个 <c>result</c>，并落盘会话日志。
    /// 回合内一切失败都在这里消化，绝不让异常逃回主循环。
    /// </summary>
    private static async Task RunTurnAsync(CliHost host, CliArgs args, string message, TextWriter stdout,
        TextWriter stderr, object writeLock, CancellationToken cancellationToken)
    {
        using var consumer = host.Bus.CreateConsumer<AgentLoopEvent>();
        using var renderCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var seq = new SeqCounter();
        var forwardTask = ForwardEventsAsync(consumer, stdout, writeLock, seq, renderCts.Token);
        var startedAt = DateTimeOffset.UtcNow;

        AgentResult? result;
        try
        {
            result = await host.Runner.RunAsync(message, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            // 回合被 interrupt 取消：合成 cancelled result。
            // AgentStopReason 无 Cancelled 值，故由宿主层映射，不改 Core 枚举。
            renderCts.Cancel();
            await StopForwarderAsync(forwardTask);
            Drain(consumer, stdout, writeLock, seq);
            EmitResult(stdout, writeLock, seq, new
            {
                answer = "",
                stop_reason = "cancelled",
                iterations = 0,
                usage = UsagePayload(TokenUsage.Zero),
            });
            return;
        }
        catch (Exception ex)
        {
            // 回合失败是消息不是崩溃：result.stop_reason:"error" 并带 failure。
            renderCts.Cancel();
            await StopForwarderAsync(forwardTask);
            Drain(consumer, stdout, writeLock, seq);
            EmitResult(stdout, writeLock, seq, new
            {
                answer = "",
                stop_reason = "error",
                iterations = 0,
                usage = UsagePayload(TokenUsage.Zero),
                failure = new { code = "model_error", message = ex.Message },
            });
            TryAppendFailure(host, args, message, ex.Message, startedAt, stderr);
            return;
        }

        renderCts.Cancel();
        await StopForwarderAsync(forwardTask);
        Drain(consumer, stdout, writeLock, seq);
        TryAppendTurn(host, args, result, startedAt, stderr);
        EmitResult(stdout, writeLock, seq, ResultPayload(result));
    }

    /// <summary>实时消费事件流并逐条写出（stdout 每条立即 flush，TUI 据此流式渲染）。</summary>
    private static async Task ForwardEventsAsync(IEventConsumer<AgentLoopEvent> consumer, TextWriter stdout,
        object writeLock, SeqCounter seq, CancellationToken cancellationToken)
    {
        await foreach (var evt in consumer.ConsumeAsync(cancellationToken))
        {
            try
            {
                EmitEvent(stdout, writeLock, seq, evt);
            }
            catch (Exception)
            {
                // 转发失败不打断回合。
            }
        }
    }

    private static async Task StopForwarderAsync(Task forwardTask)
    {
        try { await forwardTask; }
        catch (OperationCanceledException) { /* 回合结束取消转发器属预期 */ }
    }

    /// <summary>兜底排空：取消瞬间转发任务未消费的残余事件（发布同步入队，不会丢失）。</summary>
    private static void Drain(IEventConsumer<AgentLoopEvent> consumer, TextWriter stdout, object writeLock, SeqCounter seq)
    {
        while (consumer.TryRead() is { } evt)
            EmitEvent(stdout, writeLock, seq, evt);
    }

    /// <summary>发出一个 event 行；seq 在锁内分配并写出，保证线序与序号一致。</summary>
    private static void EmitEvent(TextWriter stdout, object writeLock, SeqCounter seq, AgentLoopEvent evt)
    {
        lock (writeLock)
        {
            var line = JsonSerializer.Serialize(new { type = "event", seq = seq.Next(), @event = EventPayload(evt) }, Json);
            stdout.WriteLine(line);
            stdout.Flush();
        }
    }

    /// <summary>发出 result 行（每个 prompt 请求恰好一个）。</summary>
    private static void EmitResult(TextWriter stdout, object writeLock, SeqCounter seq, object result)
    {
        lock (writeLock)
        {
            var line = JsonSerializer.Serialize(new { type = "result", seq = seq.Next(), result }, Json);
            stdout.WriteLine(line);
            stdout.Flush();
        }
    }

    private static void WriteLine(TextWriter stdout, object writeLock, string line)
    {
        lock (writeLock)
        {
            stdout.WriteLine(line);
            stdout.Flush();
        }
    }

    private static string Serialize(object value) => JsonSerializer.Serialize(value, Json);

    private static object ResultPayload(AgentResult result) => new
    {
        answer = result.Answer,
        stop_reason = result.StopReason switch
        {
            AgentStopReason.Answer => "answer",
            AgentStopReason.FinalOutputTool => "final_output_tool",
            AgentStopReason.MaxIterations => "max_iterations",
            AgentStopReason.Error => "error",
            AgentStopReason.Interrupted => "interrupted",
            _ => "error",
        },
        iterations = result.Iterations,
        usage = UsagePayload(result.Usage),
        cost = result.Cost?.Total,
        failure = result.Failure is { } f ? new { code = f.Code, message = f.Message } : null,
    };

    /// <summary>TokenUsage → 协议载荷（snake_case、null 键省略；不含计算属性，与 docs/tui-rpc.md §2.2 逐字段一致）。</summary>
    private static object UsagePayload(TokenUsage u) => new
    {
        input_tokens = u.InputTokens,
        output_tokens = u.OutputTokens,
        total_tokens = u.TotalTokens,
        cache_read_tokens = u.CacheReadTokens,
        cache_write_tokens = u.CacheWriteTokens,
        reasoning_tokens = u.ReasoningTokens,
    };

    private static object EventPayload(AgentLoopEvent evt) => evt switch
    {
        AgentLoopEvent.TextDelta d => new { kind = "text_delta", delta = d.Delta },
        AgentLoopEvent.ReasoningDelta d => new { kind = "reasoning_delta", delta = d.Delta },
        AgentLoopEvent.ToolCallDelta d => new { kind = "tool_call_delta", id = d.ToolCallId, name = d.Name, arguments = d.Arguments },
        AgentLoopEvent.ToolStarted s => new { kind = "tool_started", call = CallPayload(s.Call) },
        AgentLoopEvent.ToolCompleted c => new { kind = "tool_completed", call = CallPayload(c.Call), observation = c.Observation, is_error = c.IsError },
        AgentLoopEvent.TurnCompleted t => new
        {
            kind = "turn_completed",
            iteration = t.Iteration,
            usage = UsagePayload(t.Usage),
            cost = t.Cost?.Total,
            finish_reason = t.FinishReason.Kind,
        },
        AgentLoopEvent.RunFailed f => new { kind = "run_failed", failure = FailurePayload(f.Failure) },
        AgentLoopEvent.Interrupted => new { kind = "interrupted" },
        _ => throw new ArgumentOutOfRangeException(nameof(evt), evt, "未知的 AgentLoopEvent 类型"),
    };

    private static object CallPayload(ToolCallBlock call) => new { id = call.Id, name = call.Name, arguments = call.Arguments };

    /// <summary>LlmFailure → 协议载荷（code/message 必填，status/provider_retry_after 可空省略）。</summary>
    private static object FailurePayload(LlmFailure f) => new
    {
        code = f.Code,
        message = f.Message,
        status = f.Status,
        provider_retry_after = f.ProviderRetryAfter is { } t ? t.TotalSeconds : (double?)null,
    };

    /// <summary>回合内事件 / result 的单调序号（每回合从 1 起，连续递增）。</summary>
    private sealed class SeqCounter
    {
        private int _value;
        public int Next() => Interlocked.Increment(ref _value);
    }

    private sealed record RpcRequest(int Id, string Method, JsonObject? Params);

    /// <summary>
    /// 解析一行 NDJSON 请求。语法错误（JSON 无效 / 缺 method / 顶层非对象）抛异常，
    /// 由调用方转成 parse_error 消息后继续；params 缺省视为空对象，具体参数由各 method 处理器校验。
    /// </summary>
    private static RpcRequest ParseRequest(string line)
    {
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
            throw new FormatException("请求必须是 JSON 对象");
        if (!root.TryGetProperty("method", out var method) || method.GetString() is not { } m)
            throw new FormatException("请求缺少 method 字符串字段");
        var id = root.TryGetProperty("id", out var idElem) && idElem.ValueKind == JsonValueKind.Number
            ? idElem.GetInt32() : 0;
        var paramsObj = root.TryGetProperty("params", out var paramsElem) && paramsElem.ValueKind == JsonValueKind.Object
            ? (JsonObject?)JsonNode.Parse(paramsElem.GetRawText())
            : null;
        return new RpcRequest(id, m, paramsObj);
    }

    // ---- 会话日志（尽力而为，--no-session 时整体跳过） ----

    private static void TryAppendTurn(CliHost host, CliArgs args, AgentResult result,
        DateTimeOffset startedAt, TextWriter stderr)
    {
        if (args.NoSession)
            return;
        try { host.SessionLog?.AppendTurn(result, startedAt); }
        catch (Exception ex) { stderr.WriteLine($"⚠ 会话日志写入失败: {ex.Message}"); }
    }

    private static void TryAppendFailure(CliHost host, CliArgs args, string message, string errorMessage,
        DateTimeOffset startedAt, TextWriter stderr)
    {
        if (args.NoSession)
            return;
        try { host.SessionLog?.AppendFailure(message, errorMessage, startedAt); }
        catch (Exception ex) { stderr.WriteLine($"⚠ 会话日志写入失败: {ex.Message}"); }
    }
}
