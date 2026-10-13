using Core.AgentLoop;
using Core.Llm;
using Core.Sessions;

namespace Di.Tests.Sessions;

/// <summary>
/// <see cref="SessionStats"/> 的单元测试：聚合一次会话 JSONL 的 task_complete 记录，
/// 计算会话级缓存命中率与用量 / 成本合计。真实 SessionLog 写入 + 手工 JSONL 容错两条路径。
/// </summary>
public sealed class SessionStatsTests
{
    [Fact]
    public void Aggregate_RealSessionLog_SumsUsageAndCost_ComputesHitRate()
    {
        var root = Directory.CreateTempSubdirectory("di-session-stats-").FullName;
        try
        {
            var log = new SessionLog(new SessionLogOptions { RootDirectory = root });
            var result = new AgentResult
            {
                Answer = "ok",
                Trajectory = [ChatMessage.User("hi")],
                Iterations = 1,
                Usage = new TokenUsage(InputTokens: 100, OutputTokens: 50, CacheReadTokens: 900),
                Cost = new UsageCost(0.1, 0.2, 0.07, 0),   // Total = 0.37
                StopReason = AgentStopReason.Answer,
            };
            log.AppendTurn(result, DateTimeOffset.UtcNow);
            log.AppendTurn(result, DateTimeOffset.UtcNow);

            var stats = SessionStats.Aggregate(log.LogFilePath);

            Assert.Equal(2, stats.Turns);
            Assert.Equal(200, stats.InputTokens);
            Assert.Equal(100, stats.OutputTokens);
            Assert.Equal(1800, stats.CacheReadTokens);
            Assert.Equal(0.9, stats.CacheHitRate!.Value, precision: 10);
            Assert.Equal(0.74, stats.TotalCost!.Value, precision: 10);
            Assert.True(stats.TotalDurationMs >= 0);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Aggregate_NoTaskComplete_ReturnsZeroTurns()
    {
        var path = WriteLines(
            """{"timestamp":"2026-10-13T00:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"session_id":"x"}}""",
            """{"timestamp":"2026-10-13T00:00:00.000Z","ordinal":1,"type":"response_item","payload":{"type":"message"}}""");

        var stats = SessionStats.Aggregate(path);

        Assert.Equal(0, stats.Turns);
        Assert.Null(stats.CacheHitRate);
        Assert.Null(stats.TotalCost);
    }

    [Fact]
    public void Aggregate_SkipsMalformedLines()
    {
        var path = WriteLines(
            "这不是 JSON 行",
            """{"timestamp":"2026-10-13T00:00:00.000Z","ordinal":1,"type":"event_msg","payload":{"type":"task_complete","usage":{"input_tokens":100,"output_tokens":20,"cache_read_tokens":900},"cost":{"total":0.1}}}""");

        var stats = SessionStats.Aggregate(path);

        Assert.Equal(1, stats.Turns);
        Assert.Equal(900, stats.CacheReadTokens);
        Assert.Equal(0.9, stats.CacheHitRate!.Value, precision: 10);
        Assert.Equal(0.1, stats.TotalCost!.Value, precision: 10);
    }

    [Fact]
    public void Aggregate_FileNotFound_Throws()
    {
        var missing = Path.Combine(Path.GetTempPath(), "di-no-such-session-" + Guid.NewGuid().ToString("N") + ".jsonl");

        Assert.ThrowsAny<IOException>(() => SessionStats.Aggregate(missing));   // FileNotFoundException ⊆ IOException
    }

    private static string WriteLines(params string[] lines)
    {
        var path = Path.Combine(Path.GetTempPath(), "di-session-" + Guid.NewGuid().ToString("N") + ".jsonl");
        File.WriteAllLines(path, lines);
        return path;
    }
}
