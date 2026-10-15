using System.Text;
using System.Text.Json;
using Core.Llm;

namespace Core.Tools;

/// <summary>
/// 读文件工具：读取文件内容，每行带行号前缀（模型可精确引用"第 N 行"），
/// 支持按行范围读取（第五章：大型文件不应整读）。超过上限的文件拒绝读取。
/// 输出超行数/字节预算时截断，并给出"用 start_line=N 继续读取"的续读提示，
/// 让"一次读不完"变成可执行的续读协议（对应 pi 的 truncateHead + offset 续读）。
/// </summary>
public sealed class ReadFileTool : ICoreTool
{
    /// <summary>单次读取上限（1 MiB），防止巨型文件耗尽上下文。</summary>
    public const long MaxBytes = 1 << 20;

    /// <summary>单次输出的行数上限：文件再大也只渲染这么多行，超出提示续读。</summary>
    public const int MaxOutputLines = 2000;

    /// <summary>单次输出的字符预算：按行边界截断，防止超宽文件把上下文撑爆。</summary>
    public const int MaxOutputBytes = 64 * 1024;

    private readonly string _baseDirectory;
    private readonly long _maxBytes;

    public ReadFileTool(string baseDirectory, long? maxBytes = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(baseDirectory);
        _baseDirectory = baseDirectory;
        _maxBytes = maxBytes ?? MaxBytes;
    }

    public string Name => "read_file";

    public ChatTool Definition
    {
        get
        {
            var schema = ToolHelpers.Schema(("path", "string", "要读取的文件路径（相对工作区根目录）"));
            ToolHelpers.AddOptionalProperty(schema, "start_line", "integer", "可选：起始行号（从 1 开始）");
            ToolHelpers.AddOptionalProperty(schema, "end_line", "integer", "可选：结束行号（含，默认到文件末尾）");
            return ChatTool.Create("read_file",
                "读取文件内容，每行带行号前缀（便于后续用 edit_file 精确定位）。可用 start_line / end_line 读取指定行范围。输出超过 2000 行/64KB 会截断，并提示用 start_line 继续读取。文件超过 1MiB 会报错。",
                schema);
        }
    }

    public string PromptSnippet => "读取文件内容，带行号，可用 start_line/end_line 读行范围";

    public IReadOnlyList<string> PromptGuidelines =>
    [
        "不确定内容时先读再动，不要凭猜",
        "read_file 提示\"用 start_line=N 继续读取\"时照做，直到读完为止",
    ];

    public Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        try
        {
            // 读文件是同步实现：在重 IO 边界自检取消（Ctrl+C / RPC interrupt 落地），不干等。
            cancellationToken.ThrowIfCancellationRequested();
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
            if (info.Length > _maxBytes)
                return Task.FromResult($"error: 文件过大（{info.Length} 字节，上限 {_maxBytes} 字节），请用 start_line/end_line 分段读取");

            var lines = File.ReadAllLines(full);
            cancellationToken.ThrowIfCancellationRequested();   // 整读（最大 1 MiB）后再确认一次取消
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

            // 先按行数上限裁掉尾部，再渲染（渲染时仍受字节预算约束，按行边界截断）。
            var lineCappedEnd = Math.Min(end, start + MaxOutputLines - 1);
            var rendered = Number(lines, start - 1, lineCappedEnd, MaxOutputBytes, out var shownEnd);

            if (shownEnd < start)
                return Task.FromResult(
                    $"[第 {start} 行超过 {MaxOutputBytes} 字符，无法用 read_file 展示。建议用 bash 分段处理，或换用其它方式]");

            if (shownEnd < end)
                return Task.FromResult($"{rendered}\n\n[显示第 {start}-{shownEnd} 行（共 {lines.Length} 行）。用 start_line={shownEnd + 1} 继续读取]");

            // 用户主动用 end_line 提前收尾，但文件还有内容 → 提示剩余行数与续读起点。
            if (endLine is not null && end < lines.Length)
                return Task.FromResult($"{rendered}\n\n[文件还有 {lines.Length - end} 行。用 start_line={end + 1} 继续读取]");

            return Task.FromResult(rendered);
        }
        catch (JsonException)
        {
            return Task.FromResult("error: arguments 不是合法 JSON");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 文件被占用/无权限：返回可预期的错误观察，而不是让异常冒泡。
            return Task.FromResult($"error: 读取失败: {ex.Message}");
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException)
        {
            // 非法路径字符（如 NUL）：Path.GetFullPath 会抛 ArgumentException。
            return Task.FromResult($"error: 路径参数非法: {ex.Message}");
        }
    }

    /// <summary>
    /// 把 [from, to) 区间的行渲染成 "行号: 内容"，用 \n 分隔（跨平台一致的观察文本）。
    /// 受 <paramref name="maxChars"/> 字符预算约束：超预算在行边界处停，绝不返回半行。
    /// <paramref name="shownEnd"/> 为实际渲染到的行号（1 基，exclusive，即最后显示行号）。
    /// </summary>
    private static string Number(IReadOnlyList<string> lines, int from, int to, int maxChars, out int shownEnd)
    {
        var sb = new StringBuilder();
        var chars = 0;
        var i = from;
        for (; i < to; i++)
        {
            var line = $"{i + 1}: {lines[i]}\n";
            if (chars + line.Length > maxChars)
                break;
            sb.Append(line);
            chars += line.Length;
        }
        shownEnd = i;
        return sb.Length == 0 ? string.Empty : sb.ToString(0, sb.Length - 1);   // 去掉末尾多余换行
    }
}
