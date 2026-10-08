using System.Text.Json;
using System.Text.Json.Nodes;
using Core.AgentLoop;
using Core.Llm;

namespace Di.Cli;

/// <summary>
/// 演示用工具（MVP 脚手架）：让聊天能真正触发一次工具事件，观察"工具调用"渲染。
/// 后续替换为真实工具集。
/// </summary>
public static class DemoTools
{
    public static IReadOnlyList<ChatTool> Definitions { get; } =
    [
        ChatTool.Create("get_current_utc_time", "获取当前的 UTC 时间。参数为空。",
            (JsonObject)JsonNode.Parse("""{"type":"object","properties":{},"required":[]}""")!),
        ChatTool.Create("add_numbers", "计算两个数字的和。当用户需要算术结果时使用。",
            (JsonObject)JsonNode.Parse(
                """{"type":"object","properties":{"a":{"type":"number","description":"第一个加数"},"b":{"type":"number","description":"第二个加数"}},"required":["a","b"]}""")!),
    ];

    public sealed class Executor : IToolExecutor
    {
        public Task<string> ExecuteAsync(ToolCallBlock call, CancellationToken cancellationToken = default)
            => Task.FromResult(call.Name switch
            {
                "get_current_utc_time" => DateTimeOffset.UtcNow.ToString("yyyy-MM-dd HH:mm:ss 'UTC'"),
                "add_numbers" => AddNumbers(call.Arguments),
                _ => $"error executing tool '{call.Name}': unknown tool",
            });

        private static string AddNumbers(string arguments)
        {
            using var doc = JsonDocument.Parse(arguments);
            var root = doc.RootElement;
            var a = root.GetProperty("a").GetDouble();
            var b = root.GetProperty("b").GetDouble();
            return (a + b).ToString("0.####");
        }
    }
}
