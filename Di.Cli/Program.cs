using System.Text;
using Di.Cli;

// 固定 UTF-8：控制台代码页可能是 GBK(936)，不显式设置时中文会按代码页编码，在管道/脚本/UTF-8
// 终端里乱码（自包含单文件发布与 dotnet run 的运行时默认编码还不一致）。现代 CLI 一律 UTF-8 输出。
Console.OutputEncoding = Encoding.UTF8;
Console.InputEncoding = Encoding.UTF8;

// 极薄的桥接：把真实控制台流 + TTY 探测交给 CliApp（CliApp 不碰 Console，因此可测、可移植）。
// 组合根（配置 / DI / runner / 会话装配）在 CliHost；TTY 探测在此 —— 输出重定向（管道/文件）
// 时禁 ANSI，避免控制序列污染捕获输出。
//
// 回合级 Ctrl+C（roadmap §3 缺口 #3）：第一次取消当前回合（Repl 每回合向协调器注册自己的取消源，
// 协调器只取消该回合、抑制进程终止），第二次放行默认行为退出进程。headless / 空闲时直接退出。
var interrupt = new InterruptCoordinator();
Console.CancelKeyPress += (_, e) => e.Cancel = interrupt.RequestInterrupt();

return await new CliApp().RunAsync(
    args,
    Console.In,
    Console.Out,
    Console.Error,
    !Console.IsInputRedirected,
    !Console.IsOutputRedirected,
    interrupt.Lifetime,
    interrupt);
