using System.Globalization;
using System.Text;

namespace Core.Tools;

/// <summary>
/// 子进程重定向输出（stdout/stderr）的解码编码。
///
/// 背景：.NET 默认按 <see cref="Console.OutputEncoding"/> 解码子进程输出，而真实 CLI 里
/// .NET 启动时把控制台设成 UTF-8（65001）；但 cmd.exe / python 往管道里写的是**系统 OEM 代码页**
/// 的字节（中文系统 = GBK/936）→ 被按 UTF-8 解码就变成乱码（� 替换符）。
/// （chcp 65001 只影响控制台、不影响管道，实测无效。）
///
/// 两条解码策略：
/// <list type="number">
/// <item><b>固定编码</b>：显式固定用 OEM 代码页解码（<see cref="ChildOutput"/>）。Windows 中文系统
///   OEM = 936（GBK），cmd 写入的正是 GBK 字节 → 正确；Windows 西文系统 OEM = 437；Unix = 65001。</item>
/// <item><b>智能解码</b>（<see cref="SmartDecode"/> / <see cref="SmartOutputEncoding"/>）：先按严格
///   UTF-8 解码整段（或整条命令）字节，非法才回退 OEM。原因：.NET/.NET CLI 在 stdout 被重定向时
///   强制写 UTF-8（与 OEM 代码页无关，chcp 也无效），而 cmd 内建命令写 OEM 字节——同一管道里
///   两种生产者并存，固定任一编码都会把另一方解成乱码。智能解码"UTF-8 优先、OEM 兜底"两头兼顾。</item>
/// </list>
///
/// 例外：python 的输出编码随环境漂移（PYTHONIOENCODING / PYTHONUTF8 / Python 版本都可能让它写
/// UTF-8 而非 OEM，实测中文系统即乱码），不走本类假设 —— <see cref="PythonTool"/> 强制
/// PYTHONIOENCODING=utf-8 并显式按 UTF-8 解码，两端对齐、与机器 locale 无关。
/// </summary>
internal static class ProcessEncoding
{
    static ProcessEncoding()
    {
        // 激活 CodePagesEncodingProvider，否则 GetEncoding(936) 等传统代码页抛 NotSupportedException。
        // 该程序集随 .NET 共享框架附带（System.Text.Encoding.CodePages.dll），无需额外 NuGet 包。
        // 注意：必须放在字段初始化之前——C# 静态字段初始化先于静态构造函数执行。
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        ChildOutput = Encoding.GetEncoding(CultureInfo.CurrentCulture.TextInfo.OEMCodePage);
        StrictUtf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
    }

    /// <summary>子进程标准输出/错误流的解码编码（固定，不受 Console.OutputEncoding 影响）。</summary>
    public static Encoding ChildOutput { get; }

    /// <summary>严格 UTF-8（非法字节抛 <see cref="DecoderFallbackException"/>），供智能解码试探。</summary>
    public static Encoding StrictUtf8 { get; }

    /// <summary>
    /// 智能解码一段字节（整条命令的输出或某段缓冲）：先严格 UTF-8，非法回退 OEM。
    /// 因为一条命令的输出来自单一生产者（cmd 内建 → OEM 字节；.NET CLI → UTF-8 字节），
    /// 整段判定一次即可；纯 ASCII 两种编码结果一致。
    ///
    /// 接缝处理：<see cref="BoundedByteBuffer"/> 把超长输出切成头/尾两段分别解码，多字节 UTF-8
    /// 字符可能正好被切在段边界上，导致整段严格 UTF-8 失败、被误判成 OEM 乱码。这里在回退 OEM
    /// 前先尝试裁掉段头/段尾各 1-3 字节（被切碎的那个字符的残片）再判 UTF-8，仍失败才是真 OEM。
    /// 代价是接缝处至多损失一个字符，但保住整段的正确编码。
    /// </summary>
    public static string SmartDecode(byte[] bytes)
    {
        if (TryStrict(bytes))
            return StrictUtf8.GetString(bytes);
        // 段尾残片：多字节字符被"头段末尾"切断（开头 1-3 字节在上一段）。
        for (var cut = 1; cut <= 3 && bytes.Length > cut; cut++)
            if (TryStrict(bytes.AsSpan(0, bytes.Length - cut).ToArray()))
                return StrictUtf8.GetString(bytes, 0, bytes.Length - cut);
        // 段头残片：多字节字符被"尾段开头"切断（结尾 1-3 字节在下一段）。
        for (var cut = 1; cut <= 3 && bytes.Length > cut; cut++)
            if (TryStrict(bytes.AsSpan(cut).ToArray()))
                return StrictUtf8.GetString(bytes, cut, bytes.Length - cut);
        return ChildOutput.GetString(bytes);
    }

    private static bool TryStrict(byte[] bytes)
    {
        try
        {
            _ = StrictUtf8.GetString(bytes);
            return true;
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
    }
}
