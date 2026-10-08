using System.Text.Json;
using Core.Llm;

namespace Core.Tools;

/// <summary>
/// 搜索文件名工具（Glob）：按模式递归定位文件，如 <c>**/*.py</c>、<c>src/components/**/Button.tsx</c>。
/// 返回相对搜索起点的路径列表（用 / 分隔），最多 <see cref="MaxResults"/> 条。
/// </summary>
public sealed class GlobTool : ICoreTool
{
    public const int MaxResults = 200;

    private readonly string _baseDirectory;

    public GlobTool(string baseDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(baseDirectory);
        _baseDirectory = baseDirectory;
    }

    public string Name => "glob";

    public ChatTool Definition => ChatTool.Create("glob",
        "按 glob 模式递归查找文件（如 **/*.py、src/components/**/Button.tsx）。返回相对搜索起点的路径列表，最多 200 条；无匹配返回（未找到匹配文件）。",
        ToolHelpers.Schema(
            ("pattern", "string", "glob 模式（* 同目录内任意段，? 单字符，** 跨目录）"),
            ("path", "string", "可选：搜索起点目录（默认工作区根目录）")));

    public Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        try
        {
            using var doc = JsonDocument.Parse(argumentsJson);
            if (!ToolHelpers.TryGetString(doc.RootElement, "pattern", out var pattern, out var error))
                return Task.FromResult(error!);

            var pathArg = ToolHelpers.TryGetOptionalString(doc.RootElement, "path");
            var searchRoot = pathArg is null ? _baseDirectory : ToolHelpers.ResolvePath(_baseDirectory, pathArg);
            if (!Directory.Exists(searchRoot))
                return Task.FromResult(File.Exists(searchRoot)
                    ? $"error: 路径是文件而非目录: {pathArg}"
                    : $"error: 目录不存在: {pathArg}");

            var regex = GlobMatcher.ToRegex(pattern!, ignoreCase: OperatingSystem.IsWindows());
            var results = new List<string>();
            foreach (var file in ToolHelpers.EnumerateFiles(searchRoot))
            {
                var rel = Path.GetRelativePath(searchRoot, file).Replace('\\', '/');
                if (regex.IsMatch(rel))
                {
                    results.Add(rel);
                    if (results.Count >= MaxResults)
                        break;
                }
            }

            return Task.FromResult(results.Count == 0 ? "（未找到匹配文件）" : string.Join('\n', results));
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
}
