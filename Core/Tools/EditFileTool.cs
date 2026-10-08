using System.Text.Json;
using Core.Llm;

namespace Core.Tools;

/// <summary>
/// 编辑文件工具：用 old_string → new_string 做局部替换，代码维护与迭代的核心操作。
/// 遵循第五章 "旧字符串到新字符串" 方案：old_string 必须<b>存在且唯一</b>才成功，
/// 出现多次或未找到一律失败 —— 不做模糊替换，杜绝改错位置。
/// </summary>
public sealed class EditFileTool : ICoreTool
{
    private readonly string _baseDirectory;

    public EditFileTool(string baseDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(baseDirectory);
        _baseDirectory = baseDirectory;
    }

    public string Name => "edit_file";

    public ChatTool Definition => ChatTool.Create("edit_file",
        "替换文件中唯一的一处 old_string。old_string 必须存在且只出现一次，否则报错（不会模糊替换）。替换大段内容时请带上足够的上下文使匹配唯一。",
        ToolHelpers.Schema(
            ("path", "string", "要编辑的文件路径（相对工作区根目录）"),
            ("old_string", "string", "要替换的原文（必须在文件中出现且只出现一次）"),
            ("new_string", "string", "替换后的新文本")));

    public Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        try
        {
            using var doc = JsonDocument.Parse(argumentsJson);
            if (!ToolHelpers.TryGetString(doc.RootElement, "path", out var path, out var error))
                return Task.FromResult(error!);
            if (!ToolHelpers.TryGetString(doc.RootElement, "old_string", out var oldString, out error))
                return Task.FromResult(error!);
            if (!ToolHelpers.TryGetContent(doc.RootElement, "new_string", out var newString, out error))
                return Task.FromResult(error!);

            if (oldString!.Length == 0)
                return Task.FromResult("error: old_string 不能为空");

            var full = ToolHelpers.ResolvePath(_baseDirectory, path!);
            if (!File.Exists(full))
                return Task.FromResult($"error: 文件不存在: {path}");

            string text;
            try
            {
                text = File.ReadAllText(full);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return Task.FromResult($"error: 读取失败: {ex.Message}");
            }

            var first = text.IndexOf(oldString, StringComparison.Ordinal);
            if (first < 0)
                return Task.FromResult("error: 在文件中未找到 old_string");

            // 从 first + 1 起搜第二个：重叠出现（如 "aaa" 中 "aa" 出现在 0 和 1）也算多次，
            // 不能从 first + oldString.Length 起搜——那会漏掉重叠匹配而静默替换第一个。
            var second = text.IndexOf(oldString, first + 1, StringComparison.Ordinal);
            if (second >= 0)
                return Task.FromResult("error: old_string 在文件中出现多次，请提供更多上下文使其唯一");

            var newText = string.Concat(text.AsSpan(0, first), newString, text.AsSpan(first + oldString.Length));
            try
            {
                File.WriteAllText(full, newText);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return Task.FromResult($"error: 写入失败: {ex.Message}");
            }

            return Task.FromResult($"OK: 已替换（{CountLines(oldString)} 行 → {CountLines(newString!)} 行）");
        }
        catch (JsonException)
        {
            return Task.FromResult("error: arguments 不是合法 JSON");
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException)
        {
            // 非法路径字符（如 NUL）：路径解析会抛 ArgumentException。
            return Task.FromResult($"error: 路径参数非法: {ex.Message}");
        }
    }

    private static int CountLines(string s)
    {
        if (s.Length == 0)
            return 0;
        var count = 1;
        foreach (var c in s)
            if (c == '\n')
                count++;
        return count;
    }
}
