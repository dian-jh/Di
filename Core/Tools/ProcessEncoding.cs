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
/// 修复：显式固定用 OEM 代码页解码，不再依赖 Console.OutputEncoding 的运行时状态。
/// - Windows 中文系统：OEM = 936（GBK），cmd/python 写入的正是 GBK 字节 → 正确。
/// - Windows 西文系统：OEM = 437，cmd 写入 cp437 → 正确。
/// - Unix：OEMCodePage = 65001（UTF-8），/bin/sh、python 写 UTF-8 → 正确。
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
    }

    /// <summary>子进程标准输出/错误流的解码编码（固定，不受 Console.OutputEncoding 影响）。</summary>
    public static Encoding ChildOutput { get; }
}
