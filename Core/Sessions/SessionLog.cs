using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Core.AgentLoop;
using Core.Llm;

namespace Core.Sessions;

/// <summary>会话持久化的根配置。默认写入 ~/.di（config.json + sessions/YYYY/MM/DD/*.jsonl）。</summary>
public sealed class SessionLogOptions
{
    /// <summary>会话根目录。</summary>
    public string RootDirectory { get; init; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".di");

    /// <summary>写进 config.json 与 session_meta 的版本号。</summary>
    public string CliVersion { get; init; } = "0.1.0";

    /// <summary>session_meta 里的来源标识。</summary>
    public string Originator { get; init; } = "di";

    /// <summary>session_meta 里的来源通道。</summary>
    public string Source { get; init; } = "cli";

    /// <summary>session_meta 里的模型提供方。</summary>
    public string ModelProvider { get; init; } = "deepseek";
}

/// <summary>
/// 会话持久化：把一次 CLI 运行的每个回合追加写入一个 JSONL 文件。
/// 目录模式为 ~/.di/sessions/YYYY/MM/DD/，文件名 session-{时间戳}-{会话短id}.jsonl；
/// 首行是 session_meta，之后每回合由 task_started / turn_context / 各 response_item / task_complete 组成。
/// 每条记录是 {timestamp, ordinal, type, payload} 信封，payload 用 snake_case（参考 codex rollout 格式）。
///
/// 追加写入按行 flush，进程随时中断也不会损坏已写记录；重放 = 按行读回。
/// 线程安全：所有写入在同一把锁内，序号（ordinal）单调递增。
/// </summary>
public sealed class SessionLog
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        // 日志文件存原生 UTF-8 而非 \uXXXX 转义：体积小、可读、与 codex/Claude Code 一致。
        // "UnsafeRelaxed" 仅表示不做 HTML 转义，对本地日志无安全影响。
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly SessionLogOptions _options;
    private readonly string _cwd;
    private readonly object _lock = new();
    private long _ordinal;
    private bool _started;

    public SessionLog(SessionLogOptions options)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _cwd = Directory.GetCurrentDirectory();
        SessionId = Guid.NewGuid().ToString("N");
        EnsureConfig();
        LogFilePath = BuildFilePath(_options.RootDirectory, SessionId);
        Directory.CreateDirectory(Path.GetDirectoryName(LogFilePath)!);
    }

    /// <summary>本次会话的唯一 id（同时写入 session_meta）。</summary>
    public string SessionId { get; }

    /// <summary>本次会话日志文件的完整路径。</summary>
    public string LogFilePath { get; }

    /// <summary>已写入的记录条数（ordinal 也到此为止）。</summary>
    public long RecordCount => _ordinal;

    /// <summary>写首行 session_meta。幂等：重复调用只写一次。</summary>
    public void StartSession()
    {
        lock (_lock)
        {
            if (_started)
                return;
            _started = true;
            Append("session_meta", new
            {
                SessionId,
                Id = SessionId,
                Timestamp = Now(),
                Cwd = _cwd,
                Originator = _options.Originator,
                CliVersion = _options.CliVersion,
                Source = _options.Source,
                ThreadSource = "user",
                ModelProvider = _options.ModelProvider,
            });
        }
    }

    /// <summary>
    /// 把一个完整回合（用户请求 + 轨迹 + 结局）追加进会话文件。
    /// 轨迹里 <see cref="AgentResult.History"/> 之前的消息是上一回合已写过的历史，这里跳过，只写本回合新增。
    /// <paramref name="startedAt"/> 是回合开始时间（调用方在运行前记录），用于计算 duration_ms。
    /// </summary>
    public void AppendTurn(AgentResult result, DateTimeOffset startedAt)
    {
        ArgumentNullException.ThrowIfNull(result);
        lock (_lock)
        {
            StartSession();

            var turnId = Guid.NewGuid().ToString("N");
            var now = DateTimeOffset.UtcNow;

            Append("event_msg", new
            {
                Type = "task_started",
                TurnId = turnId,
                StartedAt = startedAt.ToUnixTimeMilliseconds(),
            });
            Append("turn_context", new { TurnId = turnId, Cwd = _cwd });

            var historyCount = result.History?.Count ?? 0;
            foreach (var message in result.Trajectory.Skip(historyCount))
                AppendMessage(message);

            Append("event_msg", new
            {
                Type = "task_complete",
                TurnId = turnId,
                LastAgentMessage = result.Answer,
                CompletedAt = now.ToUnixTimeMilliseconds(),
                DurationMs = (long)Math.Max(0, (now - startedAt).TotalMilliseconds),
            });
        }
    }

    /// <summary>把一条轨迹消息翻译成零到多条 response_item 记录（镜像 codex 的 item 结构）。</summary>
    private void AppendMessage(ChatMessage message)
    {
        switch (message)
        {
            case UserMessage user:
                Append("response_item", new
                {
                    Type = "message",
                    Role = "user",
                    Content = new[] { new { Type = "input_text", Text = GetUserText(user) } },
                });
                break;

            case AssistantMessage assistant:
                if (!string.IsNullOrEmpty(assistant.Reasoning))
                {
                    Append("response_item", new
                    {
                        Type = "reasoning",
                        Summary = new[] { new { Type = "summary_text", Text = assistant.Reasoning } },
                    });
                }
                var text = assistant.GetText();
                if (!string.IsNullOrEmpty(text))
                {
                    Append("response_item", new
                    {
                        Type = "message",
                        Role = "assistant",
                        Content = new[] { new { Type = "output_text", Text = text } },
                    });
                }
                foreach (var call in assistant.ToolCalls)
                {
                    Append("response_item", new
                    {
                        Type = "function_call",
                        Name = call.Name,
                        Arguments = call.Arguments,
                        CallId = call.Id,
                    });
                }
                break;

            case ToolResultMessage tool:
                Append("response_item", new
                {
                    Type = "function_call_output",
                    CallId = tool.ToolCallId,
                    Output = tool.Content,
                });
                break;
        }
    }

    private void Append(string type, object payload)
    {
        var line = JsonSerializer.Serialize(new
        {
            Timestamp = Now(),
            Ordinal = _ordinal++,
            Type = type,
            Payload = payload,
        }, Json);
        File.AppendAllText(LogFilePath, line + "\n", new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
    }

    /// <summary>config.json 不存在时创建（含 schema 版本与 cli 版本）；已存在则原样保留。</summary>
    private void EnsureConfig()
    {
        Directory.CreateDirectory(_options.RootDirectory);
        var configPath = Path.Combine(_options.RootDirectory, "config.json");
        if (File.Exists(configPath))
            return;
        var content = JsonSerializer.Serialize(new
        {
            SchemaVersion = 1,
            CliVersion = _options.CliVersion,
        }, Json);
        File.WriteAllText(configPath, content + "\n", new UTF8Encoding(false));
    }

    private static string GetUserText(UserMessage user) =>
        string.Concat(user.Content.OfType<TextBlock>().Select(t => t.Text));

    private static string Now() =>
        DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    private static string BuildFilePath(string root, string sessionId)
    {
        var now = DateTimeOffset.UtcNow;
        var dir = Path.Combine(root, "sessions",
            now.ToString("yyyy"), now.ToString("MM"), now.ToString("dd"));
        var file = $"session-{now:yyyy-MM-dd'T'HH-mm-ss}-{sessionId[..8]}.jsonl";
        return Path.Combine(dir, file);
    }
}
