using Di.Cli.Modes;

namespace Di.Cli;

/// <summary>
/// CLI 分派壳（对应 Pi 的 main.ts）：解析参数 → 校验 → 解析模式 → 构建宿主 → 分派到各模式执行器。
/// 不碰 Console —— 输入输出流与 TTY 探测全部由调用方（Program.cs / 测试）传入，
/// 因此可在任意宿主中重放，也可用别的语言按同一契约重写（见 docs/cli.md）。
/// </summary>
public sealed class CliApp
{
    private readonly Func<CliArgs, string, TextWriter, bool, CliHost> _hostFactory;

    public CliApp(Func<CliArgs, string, TextWriter, bool, CliHost>? hostFactory = null)
        => _hostFactory = hostFactory ?? CliHost.Create;

    /// <summary>运行一次 CLI 调用，返回进程退出码（0 = 成功，1 = 用法/运行错误）。</summary>
    public async Task<int> RunAsync(string[] args, TextReader stdin, TextWriter stdout, TextWriter stderr,
        bool stdinTty, bool stdoutTty, CancellationToken cancellationToken = default,
        InterruptCoordinator? interrupt = null)
    {
        ArgumentNullException.ThrowIfNull(args);
        ArgumentNullException.ThrowIfNull(stdin);
        ArgumentNullException.ThrowIfNull(stdout);
        ArgumentNullException.ThrowIfNull(stderr);

        var (cliArgs, diagnostics) = CliArgsParser.Parse(args);
        if (diagnostics.Any(d => d.IsError))
        {
            foreach (var diagnostic in diagnostics)
                await stderr.WriteLineAsync(diagnostic.Message);
            await stderr.WriteLineAsync("用法: di [选项] [提示词]（--help 查看完整帮助）");
            return 1;
        }

        var mode = CliMode.Resolve(cliArgs, stdinTty, stdoutTty);
        var workspace = Directory.GetCurrentDirectory();
        var useAnsi = stdoutTty && !cliArgs.NoAnsi;

        switch (mode)
        {
            case AppMode.Version:
                await stdout.WriteLineAsync(CliInfo.Version);
                return 0;

            case AppMode.Help:
                await stdout.WriteAsync(CliInfo.HelpText);
                return 0;

            case AppMode.Rpc:
                await stderr.WriteLineAsync("--mode rpc 尚未实现");
                return 1;

            default:
                // 需要真实运行的路径：构建宿主（组合根）后分派；宿主释放工具会话与 DI 容器。
                using (var host = _hostFactory(cliArgs, workspace, stderr, useAnsi))
                {
                    return mode switch
                    {
                        AppMode.ListModels => await ListModelsAsync(host, cliArgs.ListModels, stdout, cancellationToken),
                        AppMode.Interactive => await InteractiveAsync(host, stdin, stdout, interrupt, cancellationToken),
                        _ => await PrintMode.RunAsync(host, cliArgs, stdin, stdout, stderr, cancellationToken),
                    };
                }
        }
    }

    /// <summary>交互 REPL：stdin 经流式行读取器喂给 Repl，stdout 渲染。</summary>
    private static async Task<int> InteractiveAsync(CliHost host, TextReader stdin, TextWriter stdout,
        InterruptCoordinator? interrupt, CancellationToken cancellationToken)
    {
        var repl = new Repl(host.Runner, host.Bus, new StreamLineReader(stdin), stdout,
            host.ReplOptions, host.SessionLog, host.Skills, interrupt: interrupt);
        await repl.RunAsync(cancellationToken);
        return 0;
    }

    /// <summary>列出模型目录（咨询性、尽力而为）；带 pattern 时按 id/provider 子串过滤。</summary>
    private static Task<int> ListModelsAsync(CliHost host, string? pattern, TextWriter stdout,
        CancellationToken cancellationToken)
    {
        var models = host.Llm.ListModels();
        if (!string.IsNullOrWhiteSpace(pattern))
        {
            models = models
                .Where(m => m.Id.Contains(pattern, StringComparison.OrdinalIgnoreCase)
                            || m.Provider.Contains(pattern, StringComparison.OrdinalIgnoreCase))
                .ToList();
        }
        foreach (var model in models.OrderBy(m => m.Provider, StringComparer.Ordinal).ThenBy(m => m.Id, StringComparer.Ordinal))
            stdout.WriteLine($"{model.Provider}/{model.Id}  {model.Name}");
        if (models.Count == 0)
            stdout.WriteLine("（无可用模型 —— 检查 provider 配置与网络）");
        return Task.FromResult(0);
    }
}
