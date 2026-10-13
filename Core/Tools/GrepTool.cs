using System.Text.Json;
using System.Text.RegularExpressions;
using Core.Llm;

namespace Core.Tools;

/// <summary>
/// 搜索文件内容工具（Grep）：按正则表达式逐行扫描文件内容。
/// 返回格式（第五章示例）：相对路径:行号: 内容，如 src/api.py:42: # TODO: ...
/// 支持 glob 过滤文件类型、path 限定搜索起点、ignore_case/literal 控制匹配方式、
/// context 显示上下文行；跳过超大（超过 1 MiB）/二进制文件，且跳过会<b>如实上报</b>
/// （"N 个文件超过 1 MiB 已跳过…"），避免与"确实没有匹配"混淆——否则被跳过大文件里的
/// 命中会伪装成"未找到匹配"（假阴性）。
/// 输出受限时给出可执行的续查提示（对应 pi grep）：达匹配上限提示"用 limit=2N 续查"，
/// 长行按 <see cref="MaxMatchLineChars"/> 截断并提示"用 read_file 看完整行"。
/// </summary>
public sealed class GrepTool : ICoreTool
{
    public const int MaxResults = 100;
    public const long MaxFileBytes = 1 << 20;

    /// <summary>单条匹配行输出的最大字符数，超出按此截断（防止超宽行撑爆输出）。</summary>
    public const int MaxMatchLineChars = 500;

    private readonly string _baseDirectory;
    private readonly int _maxResults;
    private readonly long _maxFileBytes;

    public GrepTool(string baseDirectory, int? maxResults = null, long? maxFileBytes = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(baseDirectory);
        _baseDirectory = baseDirectory;
        _maxResults = maxResults ?? MaxResults;
        _maxFileBytes = maxFileBytes ?? MaxFileBytes;
    }

    public string Name => "grep";

    public ChatTool Definition
    {
        get
        {
            var schema = ToolHelpers.Schema(("pattern", "string", "要搜索的正则表达式（literal 模式下为普通文本）"));
            ToolHelpers.AddOptionalProperty(schema, "path", "string", "可选：搜索起点目录（默认工作区根目录）");
            ToolHelpers.AddOptionalProperty(schema, "glob", "string", "可选：只搜索路径匹配该 glob 的文件，如 *.cs");
            ToolHelpers.AddOptionalProperty(schema, "ignore_case", "boolean", "可选：大小写不敏感匹配（默认 false）");
            ToolHelpers.AddOptionalProperty(schema, "literal", "boolean", "可选：把 pattern 当普通文本而非正则（默认 false）");
            ToolHelpers.AddOptionalProperty(schema, "context", "integer", "可选：匹配行前后各显示的上下文行数（默认 0）");
            ToolHelpers.AddOptionalProperty(schema, "limit", "integer", "可选：最多返回的匹配条数（默认 100）");
            return ChatTool.Create("grep",
                "在文件内容中按模式逐行搜索，返回 file:行号: 内容（如 src/api.py:42: # TODO: ...）。可用 glob 过滤文件、path 限定目录、context 显示上下文行、ignore_case/literal 控制匹配方式。默认最多 100 条（可用 limit 调整），长行按 500 字符截断。",
                schema);
        }
    }

    public string PromptSnippet => "按模式搜索文件内容，返回 file:行号: 内容";

    public IReadOnlyList<string> PromptGuidelines =>
    [
        "定位代码逻辑用 grep 先搜再读，不要编造文件内容",
    ];

    public Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        try
        {
            using var doc = JsonDocument.Parse(argumentsJson);
            if (!ToolHelpers.TryGetString(doc.RootElement, "pattern", out var pattern, out var error))
                return Task.FromResult(error!);
            if (!ToolHelpers.TryGetOptionalBool(doc.RootElement, "ignore_case", out var ignoreCase, out error))
                return Task.FromResult(error!);
            if (!ToolHelpers.TryGetOptionalBool(doc.RootElement, "literal", out var literal, out error))
                return Task.FromResult(error!);
            if (!ToolHelpers.TryGetOptionalInt(doc.RootElement, "context", out var context, out error))
                return Task.FromResult(error!);
            if (!ToolHelpers.TryGetOptionalInt(doc.RootElement, "limit", out var limit, out error))
                return Task.FromResult(error!);

            Regex regex;
            try
            {
                var options = RegexOptions.CultureInvariant;
                if (ignoreCase == true)
                    options |= RegexOptions.IgnoreCase;
                var effectivePattern = literal == true ? Regex.Escape(pattern!) : pattern!;
                regex = new Regex(effectivePattern, options);
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

            var effectiveLimit = Math.Max(1, limit ?? _maxResults);
            var contextValue = context is > 0 ? context.Value : 0;
            var matchCount = 0;
            var matchLimitReached = false;
            var linesTruncated = false;
            var skippedOverSize = new List<string>();   // 超限文件：跳过但如实上报，避免与"无匹配"混淆
            var skippedOverSizeTotal = 0;
            var results = new List<string>();

            foreach (var file in ToolHelpers.EnumerateFiles(searchRoot))
            {
                if (matchCount >= effectiveLimit)
                    break;
                var rel = Path.GetRelativePath(searchRoot, file).Replace('\\', '/');
                if (globRegex is not null && !globRegex.IsMatch(rel))
                    continue;
                if (new FileInfo(file).Length > _maxFileBytes)
                {
                    skippedOverSizeTotal++;
                    if (skippedOverSize.Count < 3)
                        skippedOverSize.Add(rel);
                    continue;
                }

                try
                {
                    if (contextValue == 0)
                    {
                        var lineNo = 0;
                        foreach (var line in File.ReadLines(file))
                        {
                            lineNo++;
                            if (!regex.IsMatch(line))
                                continue;
                            matchCount++;
                            results.Add($"{rel}:{lineNo}: {TruncateLine(line, ref linesTruncated)}");
                            if (matchCount >= effectiveLimit)
                            {
                                matchLimitReached = true;
                                break;
                            }
                        }
                    }
                    else
                    {
                        ScanWithContext(file, rel, regex, contextValue, effectiveLimit, results,
                            ref matchCount, ref matchLimitReached, ref linesTruncated);
                    }
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    continue;   // 单个文件读不动不阻塞整个搜索
                }
            }

            // 有超限文件被跳过时不输出"（未找到匹配）"，避免与"确实没有匹配"混淆；跳过提示作主输出。
            var output = results.Count == 0 && skippedOverSizeTotal == 0
                ? "（未找到匹配）"
                : string.Join('\n', results);
            var notices = new List<string>();
            if (skippedOverSizeTotal > 0)
            {
                // 前 3 个文件名作样本（超出只列样本）；前面的数字就是被跳过的总数。
                var sample = string.Join("、", skippedOverSize.Select(s => $"“{s}”"));
                notices.Add($"{skippedOverSizeTotal} 个文件超过 {_maxFileBytes / (1024 * 1024)} MiB 已跳过（如 {sample}）。可用 read_file 分段读取，或用 python/findstr 处理");
            }
            if (matchLimitReached)
                notices.Add($"{effectiveLimit} 条匹配上限已到。用 limit={effectiveLimit * 2} 查看更多，或缩小 pattern");
            if (linesTruncated)
                notices.Add($"部分行超过 {MaxMatchLineChars} 字符已截断，用 read_file 查看完整行");
            if (notices.Count > 0)
                output += $"\n\n[{string.Join(". ", notices)}]";

            return Task.FromResult(output);
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

    /// <summary>
    /// 带上下文窗口的扫描：先收集单个文件的所有命中行，再逐条输出 [行-ctx, 行+ctx] 窗口。
    /// 上下文行格式 rel-行号- 内容（与匹配行的 rel:行号: 区分），重叠窗口不重复输出。
    /// </summary>
    private static void ScanWithContext(
        string file, string rel, Regex regex, int context, int effectiveLimit, List<string> results,
        ref int matchCount, ref bool matchLimitReached, ref bool linesTruncated)
    {
        var fileLines = File.ReadAllLines(file);
        var lastEmitted = 0;   // 该文件已输出的最大行号（窗口重叠时跳过，避免重复）
        for (var idx = 0; idx < fileLines.Length; idx++)
        {
            if (matchCount >= effectiveLimit)
                break;
            if (!regex.IsMatch(fileLines[idx]))
                continue;
            matchCount++;
            var start = Math.Max(1, idx + 1 - context);
            var end = Math.Min(fileLines.Length, idx + 1 + context);
            if (start <= lastEmitted)
                start = lastEmitted + 1;
            for (var n = start; n <= end; n++)
            {
                var text = TruncateLine(fileLines[n - 1], ref linesTruncated);
                results.Add(n == idx + 1 ? $"{rel}:{n}: {text}" : $"{rel}-{n}- {text}");
            }
            lastEmitted = Math.Max(lastEmitted, end);
            if (matchCount >= effectiveLimit)
            {
                matchLimitReached = true;
                break;
            }
        }
    }

    /// <summary>把超过 <see cref="MaxMatchLineChars"/> 的行截断并追加 [truncated] 标记。</summary>
    private static string TruncateLine(string line, ref bool linesTruncated)
    {
        if (line.Length <= MaxMatchLineChars)
            return line;
        linesTruncated = true;
        return line[..MaxMatchLineChars] + "... [truncated]";
    }
}
