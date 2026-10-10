using Di.Cli;

// 极薄的桥接：把真实控制台流 + TTY 探测交给 CliApp（CliApp 不碰 Console，因此可测、可移植）。
// 组合根（配置 / DI / runner / 会话装配）在 CliHost；TTY 探测在此 —— 输出重定向（管道/文件）
// 时禁 ANSI，避免控制序列污染捕获输出。
return await new CliApp().RunAsync(
    args,
    Console.In,
    Console.Out,
    Console.Error,
    !Console.IsInputRedirected,
    !Console.IsOutputRedirected);
