using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Core.Tools;

/// <summary>
/// 七个核心工具共享的小助手：参数解析、路径解析、JSON Schema 构造、长输出截断。
/// </summary>
internal static class ToolHelpers
{
    /// <summary>把（可能相对的）路径解析为相对工作区根目录的绝对路径，并把 / 统一为平台分隔符。</summary>
    public static string ResolvePath(string baseDirectory, string path) =>
        Path.GetFullPath(Path.Combine(baseDirectory, path.Replace('/', Path.DirectorySeparatorChar)));

    /// <summary>构造一个所有列出的参数均必填的 object JSON Schema。</summary>
    public static JsonObject Schema(params (string Name, string Type, string Description)[] properties)
    {
        var schema = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject(),
            ["required"] = new JsonArray(),
        };
        var props = (JsonObject)schema["properties"]!;
        var required = (JsonArray)schema["required"]!;
        foreach (var (name, type, description) in properties)
        {
            props[name] = new JsonObject { ["type"] = type, ["description"] = description };
            required.Add(name);
        }
        return schema;
    }

    /// <summary>读取必需的 string 参数；缺失/非字符串/空白时写出 error 观察并返回 false。</summary>
    public static bool TryGetString(JsonElement root, string name, out string? value, out string? error)
    {
        if (!root.TryGetProperty(name, out var prop) || prop.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(prop.GetString()))
        {
            value = null;
            error = $"error: 缺少 string 参数 '{name}'";
            return false;
        }
        value = prop.GetString();
        error = null;
        return true;
    }

    /// <summary>读取 string 参数且允许空串/纯空白（文件内容等）。缺失或非字符串返回 error。</summary>
    public static bool TryGetContent(JsonElement root, string name, out string? value, out string? error)
    {
        if (!root.TryGetProperty(name, out var prop) || prop.ValueKind != JsonValueKind.String)
        {
            value = null;
            error = $"error: 缺少 string 参数 '{name}'";
            return false;
        }
        value = prop.GetString();
        error = null;
        return true;
    }

    /// <summary>读取可选的 string 参数；缺失或非字符串返回 null（不报错）。</summary>
    public static string? TryGetOptionalString(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var prop) || prop.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(prop.GetString()))
            return null;
        return prop.GetString();
    }

    /// <summary>读取可选的整数参数；存在但非法时写出 error 观察并返回 false。</summary>
    public static bool TryGetOptionalInt(JsonElement root, string name, out int? value, out string? error)
    {
        if (!root.TryGetProperty(name, out var prop))
        {
            value = null;
            error = null;
            return true;
        }
        if (prop.ValueKind != JsonValueKind.Number || !prop.TryGetInt32(out var parsed))
        {
            value = null;
            error = $"error: 参数 '{name}' 必须是整数";
            return false;
        }
        value = parsed;
        error = null;
        return true;
    }

    /// <summary>
    /// 递归列出目录下所有文件；无权限/被占用的子目录跳过，不让整个遍历失败。
    /// 符号链接/联接（junction）子目录被跳过：Windows 常见 junction 环（如指向祖先目录）
    /// 会让朴素遍历无限循环。搜索起点本身若是链接仍正常遍历（用户可能把工作区建在链接上）。
    /// </summary>
    public static IEnumerable<string> EnumerateFiles(string root)
    {
        var pending = new Stack<(string Dir, bool IsRoot)>();
        pending.Push((root, true));
        while (pending.Count > 0)
        {
            var (dir, isRoot) = pending.Pop();
            if (!isRoot && IsLink(dir))
                continue;   // 链接目录不深入，杜绝目录环

            string[] dirs;
            string[] files;
            try
            {
                dirs = Directory.GetDirectories(dir);
                files = Directory.GetFiles(dir);
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
            {
                continue;
            }
            foreach (var file in files)
                yield return file;
            foreach (var sub in dirs)
                pending.Push((sub, false));
        }
    }

    /// <summary>判断目录是否为符号链接/联接（junction）——深入会带来目录环，遍历时跳过。</summary>
    private static bool IsLink(string dir)
    {
        try
        {
            // Windows：ReparsePoint 属性；Unix：DirectoryInfo.LinkTarget 非空即符号链接。
            // 属性读不到（无权限等）时保守返回 true 跳过，避免死循环。
            return (File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0
                || new DirectoryInfo(dir).LinkTarget is not null;
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or PlatformNotSupportedException)
        {
            return true;
        }
    }

    /// <summary>长输出截断：保留头部（通常含错误上下文）与尾部（通常含错误总结），中间以提示行替代。</summary>
    public static string Truncate(string text, int headChars = 3000, int tailChars = 1000)
    {
        if (text.Length <= headChars + tailChars)
            return text;
        return string.Concat(
            text.AsSpan(0, headChars),
            $"\n…[输出过长，已截断中间 {text.Length - headChars - tailChars} 字符]…\n",
            text.AsSpan(text.Length - tailChars));
    }
}
