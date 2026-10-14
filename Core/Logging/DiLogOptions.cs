using Core.Configuration;

namespace Core.Logging;

/// <summary>
/// 文本运行日志（jcode 风格）的根配置。默认写入 ~/.di/logs/di-YYYY-MM-DD.log（根目录经
/// <see cref="DiHome"/> 解析，可用 DI_HOME 环境变量覆盖）。设计文档见 docs/modules/logging.md。
/// </summary>
public sealed class DiLogOptions
{
    /// <summary>日志根目录（<c>RootDirectory/logs/</c> 下按日一个文件）。</summary>
    public string RootDirectory { get; init; } = DiHome.Resolve().RootDirectory;

    /// <summary>时钟（本地时间）：决定日志行的时间戳与按日轮转的日期键；测试注入假时钟。</summary>
    public Func<DateTimeOffset> Clock { get; init; } = static () => DateTimeOffset.Now;
}

/// <summary>日志级别（映射 jcode 的 [INFO] / [WARN] / [ERROR]）。</summary>
public enum LogLevel
{
    Info,
    Warn,
    Error,
}