using System.Text.Json;
using Core.Llm;

namespace Core.Tools;

/// <summary>
/// 写文件工具：创建新文件或完全覆盖现有文件，自动创建缺失的父目录。
/// 目标路径若是目录则拒绝，避免误写。
/// </summary>
public sealed class WriteFileTool : ICoreTool
{
    private readonly string _baseDirectory;

    public WriteFileTool(string baseDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(baseDirectory);
        _baseDirectory = baseDirectory;
    }

    public string Name => "write_file";

    public ChatTool Definition => ChatTool.Create("write_file",
        "创建新文件或完全覆盖现有文件（自动创建缺失的父目录）。",
        ToolHelpers.Schema(
            ("path", "string", "要写入的文件路径（相对工作区根目录）"),
            ("content", "string", "完整文件内容，会覆盖原有内容")));

    public Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        try
        {
            using var doc = JsonDocument.Parse(argumentsJson);
            if (!ToolHelpers.TryGetString(doc.RootElement, "path", out var path, out var error))
                return Task.FromResult(error!);
            if (!ToolHelpers.TryGetContent(doc.RootElement, "content", out var content, out error))
                return Task.FromResult(error!);

            var full = ToolHelpers.ResolvePath(_baseDirectory, path!);
            if (Directory.Exists(full))
                return Task.FromResult($"error: 目标路径是目录，无法写入: {path}");

            var parent = Path.GetDirectoryName(full);
            if (!string.IsNullOrEmpty(parent))
                Directory.CreateDirectory(parent);

            File.WriteAllText(full, content);
            return Task.FromResult($"OK: 已写入 {content!.Length} 字符到 {path}");
        }
        catch (JsonException)
        {
            return Task.FromResult("error: arguments 不是合法 JSON");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return Task.FromResult($"error: 写入失败: {ex.Message}");
        }
    }
}
