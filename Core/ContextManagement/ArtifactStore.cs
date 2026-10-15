using System.Text;

namespace Core.ContextManagement;

/// <summary>
/// L1 工具结果落盘：完整输出写入
/// <c>&lt;diHome&gt;/sessions/YYYY/MM/DD/artifacts/tool-&lt;tool&gt;-&lt;ts&gt;.txt</c>（docs/context-compression.md §7.1）。
/// 阶段一尚未有"每会话目录"（session 子目录随阶段二迁入），artifacts 先按天落盘；
/// 文件名带进程内自增序号，保证同一毫秒内多次落盘不互相覆盖。
/// </summary>
public sealed class ArtifactStore : IArtifactStore
{
    private static int _sequence;

    /// <summary>artifacts 目录（绝对路径）。</summary>
    public string ArtifactsDirectory { get; }

    /// <param name="diHomeRoot">Di 家目录根（~/.di，经 <see cref="Core.Configuration.DiHome"/> 解析）。</param>
    /// <param name="now">时钟（测试注入固定时间，默认真实 UTC 时间）。</param>
    public ArtifactStore(string diHomeRoot, DateTimeOffset? now = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(diHomeRoot);
        var ts = now ?? DateTimeOffset.UtcNow;
        ArtifactsDirectory = Path.Combine(diHomeRoot, "sessions",
            ts.Year.ToString("D4", System.Globalization.CultureInfo.InvariantCulture),
            ts.Month.ToString("D2", System.Globalization.CultureInfo.InvariantCulture),
            ts.Day.ToString("D2", System.Globalization.CultureInfo.InvariantCulture),
            "artifacts");
    }

    /// <inheritdoc />
    public string Write(string toolName, string content)
    {
        Directory.CreateDirectory(ArtifactsDirectory);
        var safeName = Sanitize(toolName);
        var stamp = DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmssfff",
            System.Globalization.CultureInfo.InvariantCulture);
        var name = $"tool-{safeName}-{stamp}-{Interlocked.Increment(ref _sequence):D3}.txt";
        var path = Path.Combine(ArtifactsDirectory, name);
        File.WriteAllText(path, content, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        return path;
    }

    /// <summary>工具名校验到文件名安全字符（字母/数字/-/_），其余替换为 '-'；空名兜底 "tool"。</summary>
    private static string Sanitize(string? toolName)
    {
        if (string.IsNullOrEmpty(toolName))
            return "tool";
        var sb = new StringBuilder(toolName.Length);
        foreach (var c in toolName)
            sb.Append(char.IsAsciiLetterOrDigit(c) || c is '-' or '_' ? c : '-');
        return sb.ToString();
    }
}