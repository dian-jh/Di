using System.Text;
using System.Text.Json;
using Core.Llm;

namespace Core.Tools;

/// <summary>
/// 读文件工具：读取文件内容，每行带行号前缀（模型可精确引用"第 N 行"），
/// 支持按行范围读取（第五章：大型文件不应整读）。超过上限的文件拒绝读取。
/// </summary>
public sealed class ReadFileTool : ICoreTool
{
    /// <summary>单次读取上限（1 MiB），防止巨型文件耗尽上下文。</summary>
    public const long MaxBytes = 1 << 20;

    private readonly string _baseDirectory;

    public ReadFileTool(string baseDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(baseDirectory);
        _baseDirectory = baseDirectory;
    }

    public string Name => "read_file";

    public ChatTool Definition => ChatTool.Create("read_file",
        "读取文件内容，每行带行号前缀（便于后续用 edit_file 精确定位）。可用 start_line / end_line 读取指定行范围。文件超过 1MiB 会报错。",
        ToolHelpers.Schema(
            ("path", "string", "要读取的文件路径（相对工作区根目录）"),
            ("start_line", "integer", "可选：起始行号（从 1 开始）"),
            ("end_line", "integer", "可选：结束行号（含，默认到文件末尾）")));

    public Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        try
        {
            using var doc = JsonDocument.Parse(argumentsJson);
            if (!ToolHelpers.TryGetString(doc.RootElement, "path", out var path, out var error))
                return Task.FromResult(error!);
            if (!ToolHelpers.TryGetOptionalInt(doc.RootElement, "start_line", out var startLine, out error))
                return Task.FromResult(error!);
            if (!ToolHelpers.TryGetOptionalInt(doc.RootElement, "end_line", out var endLine, out error))
                return Task.FromResult(error!);

            var full = ToolHelpers.ResolvePath(_baseDirectory, path!);
            if (Directory.Exists(full))
                return Task.FromResult($"error: 目标路径是目录，无法读取: {path}");
            if (!File.Exists(full))
                return Task.FromResult($"error: 文件不存在: {path}");

            var info = new FileInfo(full);
            if (info.Length > MaxBytes)
                return Task.FromResult($"error: 文件过大（{info.Length} 字节，上限 {MaxBytes} 字节）");

            var lines = File.ReadAllLines(full);
            if (lines.Length == 0)
                return Task.FromResult(string.Empty);

            var start = startLine ?? 1;
            var end = endLine ?? lines.Length;
            if (start < 1)
                return Task.FromResult($"error: start_line 必须 ≥ 1（当前 {start}）");
            if (end < start)
                return Task.FromResult($"error: end_line（{end}）小于 start_line（{start}）");
            if (start > lines.Length)
                return Task.FromResult($"error: start_line（{start}）超出文件行数（{lines.Length}）");
            end = Math.Min(end, lines.Length);

            return Task.FromResult(Number(lines, start - 1, end));
        }
        catch (JsonException)
        {
            return Task.FromResult("error: arguments 不是合法 JSON");
        }
    }

    /// <summary>把 [from, to) 区间的行渲染成 "行号: 内容"，用 \n 分隔（跨平台一致的观察文本）。</summary>
    private static string Number(IReadOnlyList<string> lines, int from, int to)
    {
        var sb = new StringBuilder();
        for (var i = from; i < to; i++)
            sb.Append(i + 1).Append(": ").Append(lines[i]).Append('\n');
        return sb.Length == 0 ? string.Empty : sb.ToString(0, sb.Length - 1);   // 去掉末尾多余换行
    }
}
