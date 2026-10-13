namespace Di.Cli.Commands;

/// <summary>
/// 从 <c>~/.di/commands/*.md</c> 加载用户斜杠命令（扁平文件，命令名 = 文件名）。
/// 对齐 skills 的"坏文件不阻塞启动"：无效文件告警跳过；与既有命令重名告警跳过（先注册优先）。
/// 用户命令是回合型：正文指令模板 + 调用参数请求宿主运行一个完整回合（MVP 不做 $1 占位符替换）。
/// </summary>
public static class CommandLoader
{
    /// <summary>把目录内全部合法用户命令注册进 <paramref name="registry"/>，返回注册条数。</summary>
    public static int LoadInto(SlashCommandRegistry registry, string commandsDirectory, Action<string>? warn = null)
    {
        ArgumentNullException.ThrowIfNull(registry);
        if (!Directory.Exists(commandsDirectory))
            return 0;

        var loaded = 0;
        foreach (var file in Directory.EnumerateFiles(commandsDirectory, "*.md").OrderBy(f => f, StringComparer.Ordinal))
        {
            var name = Path.GetFileNameWithoutExtension(file);

            if (registry.TryGet(name, out _))
            {
                warn?.Invoke($"跳过命令 /{name}：与既有命令重名（{file}）");
                continue;
            }

            try
            {
                var cmd = CommandMarkdown.Parse(File.ReadAllText(file), name);
                registry.Register(new SlashCommand(cmd.Name, cmd.Description, cmd.ArgumentHint,
                    (args, ctx) => Task.FromResult(CommandResult.Turn(ComposeMessage(cmd.Body, args)))));
                loaded++;
            }
            catch (Exception ex) when (ex is CommandFormatException or IOException or UnauthorizedAccessException)
            {
                warn?.Invoke($"跳过无效命令 {file}: {ex.Message}");
            }
        }
        return loaded;
    }

    /// <summary>指令模板 + 参数拼接：有参数时追加到正文尾部（MVP 不做占位符替换）。</summary>
    private static string ComposeMessage(string body, string args)
        => args.Length == 0 ? body : $"{body}\n\n{args}";
}