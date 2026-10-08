using System.Text.Json;
using System.Text.RegularExpressions;
using Core.Llm;

namespace Core.Tools;

/// <summary>
/// 搜索文件内容工具（Grep）：按正则表达式逐行扫描文件内容。
/// 返回格式（第五章示例）：相对路径:行号: 内容，如 src/api.py:42: # TODO: ...
/// 支持 glob 过滤文件类型、path 限定搜索起点；跳过超大/二进制文件。
/// </summary>
public sealed class GrepTool : ICoreTool
{
    public const int MaxResults = 100;
    public const long MaxFileBytes = 1 << 20;

    private readonly string _baseDirectory;

    public GrepTool(string baseDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(baseDirectory);
        _baseDirectory = baseDirectory;
    }

    public string Name => "grep";

    public ChatTool Definition => ChatTool.Create("grep",
        "在文件内容中按正则表达式逐行搜索，返回 file:行号: 内容（如 src/api.py:42: # TODO: ...）。可用 glob 过滤文件、path 限定目录。最多返回 100 条。",
        ToolHelpers.Schema(
            ("pattern", "string", "要搜索的正则表达式"),
            ("path", "string", "可选：搜索起点目录（默认工作区根目录）"),
            ("glob", "string", "可选：只搜索路径匹配该 glob 的文件，如 *.cs")));

    public Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        try
        {
            using var doc = JsonDocument.Parse(argumentsJson);
            if (!ToolHelpers.TryGetString(doc.RootElement, "pattern", out var pattern, out var error))
                return Task.FromResult(error!);

            Regex regex;
            try
            {
                regex = new Regex(pattern!, RegexOptions.CultureInvariant);
            }
            catch (ArgumentException ex)
            {
                return Task.FromResult($"error: 无效正则表达式: {ex.Message}");
            }

            var pathArg = ToolHelpers.TryGetOptionalString(doc.RootElement, "path");
            var searchRoot = pathArg is null ? _baseDirectory : ToolHelpers.ResolvePath(_baseDirectory, pathArg);
            if (!Directory.Exists(searchRoot))
                return Task.FromResult(File.Exists(searchRoot)
                    ? $"error: 路径是文件而非目录: {pathArg}"
                    : $"error: 目录不存在: {pathArg}");

            var globArg = ToolHelpers.TryGetOptionalString(doc.RootElement, "glob");
            var globRegex = globArg is null ? null : GlobMatcher.ToRegex(globArg, ignoreCase: OperatingSystem.IsWindows());

            var results = new List<string>();
            foreach (var file in ToolHelpers.EnumerateFiles(searchRoot))
            {
                var rel = Path.GetRelativePath(searchRoot, file).Replace('\\', '/');
                if (globRegex is not null && !globRegex.IsMatch(rel))
                    continue;
                if (new FileInfo(file).Length > MaxFileBytes)
                    continue;

                try
                {
                    var lineNo = 0;
                    foreach (var line in File.ReadLines(file))
                    {
                        lineNo++;
                        if (regex.IsMatch(line))
                        {
                            results.Add($"{rel}:{lineNo}: {line}");
                            if (results.Count >= MaxResults)
                                break;
                        }
                    }
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    continue;   // 单个文件读不动不阻塞整个搜索
                }

                if (results.Count >= MaxResults)
                    break;
            }

            return Task.FromResult(results.Count == 0 ? "（未找到匹配）" : string.Join('\n', results));
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
