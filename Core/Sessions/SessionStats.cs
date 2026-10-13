using System.Text.Json;

namespace Core.Sessions;

/// <summary>一个会话文件（JSONL）的聚合统计：回合数、token 用量、缓存命中率、成本与耗时。</summary>
public sealed record SessionStatsSummary(
    int Turns,
    long InputTokens,
    long OutputTokens,
    long CacheReadTokens,
    long CacheWriteTokens,
    double? CacheHitRate,
    double? TotalCost,
    long? TotalDurationMs);

/// <summary>
/// 解析一次会话 JSONL（<see cref="SessionLog"/> 的产物），聚合全部 task_complete 记录。
/// 会话级缓存命中率 = Σcache_read ÷ Σ计费输入（input + cache_read + cache_write）。
/// 容错：无法解析的行跳过（不中断聚合）；文件不存在 / 无法读取时抛 <see cref="IOException"/>。
/// </summary>
public static class SessionStats
{
    public static SessionStatsSummary Aggregate(string logFilePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(logFilePath);

        var turns = 0;
        long input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
        double? totalCost = null;
        long? totalDuration = null;

        foreach (var raw in File.ReadLines(logFilePath))
        {
            if (string.IsNullOrWhiteSpace(raw))
                continue;

            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(raw);
            }
            catch (JsonException)
            {
                continue;   // 容错：无法解析的行跳过，不中断聚合
            }

            using (doc)
            {
                var root = doc.RootElement;
                if (root.TryGetProperty("type", out var type) && type.GetString() == "event_msg" &&
                    root.TryGetProperty("payload", out var payload) &&
                    payload.TryGetProperty("type", out var payloadType) &&
                    payloadType.GetString() == "task_complete")
                {
                    turns++;
                    if (payload.TryGetProperty("usage", out var usage))
                    {
                        input += GetInt64(usage, "input_tokens");
                        output += GetInt64(usage, "output_tokens");
                        cacheRead += GetInt64(usage, "cache_read_tokens");
                        cacheWrite += GetInt64(usage, "cache_write_tokens");
                    }
                    if (payload.TryGetProperty("cost", out var cost) && cost.TryGetProperty("total", out var total))
                        totalCost = (totalCost ?? 0) + total.GetDouble();
                    if (payload.TryGetProperty("duration_ms", out var duration))
                        totalDuration = (totalDuration ?? 0) + duration.GetInt64();
                }
            }
        }

        var billable = input + cacheRead + cacheWrite;
        double? hitRate = billable > 0 ? (double)cacheRead / billable : null;

        return new SessionStatsSummary(turns, input, output, cacheRead, cacheWrite, hitRate, totalCost, totalDuration);
    }

    private static long GetInt64(JsonElement obj, string property) =>
        obj.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt64()
            : 0;
}
