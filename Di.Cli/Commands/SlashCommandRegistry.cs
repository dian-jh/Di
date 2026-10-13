namespace Di.Cli.Commands;

/// <summary>
/// 斜杠命令注册表（对齐 Pi 的 <c>SlashCommands</c> 服务）：注册 / 列举 / 按名解析。
/// 重名注册抛异常（唯一名）；<see cref="List"/> 按名排序供 /help 与 TUI 命令菜单。
/// </summary>
public sealed class SlashCommandRegistry
{
    private readonly Dictionary<string, SlashCommand> _commands = new(StringComparer.Ordinal);

    public void Register(SlashCommand command)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentException.ThrowIfNullOrWhiteSpace(command.Name);
        if (!_commands.TryAdd(command.Name, command))
            throw new InvalidOperationException($"斜杠命令 /{command.Name} 已注册");
    }

    public void RegisterAll(IEnumerable<SlashCommand> commands)
    {
        ArgumentNullException.ThrowIfNull(commands);
        foreach (var command in commands)
            Register(command);
    }

    public IReadOnlyList<SlashCommand> List() => [.. _commands.Values.OrderBy(c => c.Name, StringComparer.Ordinal)];

    public bool TryGet(string name, out SlashCommand? command) => _commands.TryGetValue(name, out command);

    /// <summary>把一行命令输入拆成 (名称含前导斜杠, 参数)；无空格时参数为空串，参数两侧去空白。</summary>
    public static (string Name, string Args) Split(string line)
    {
        var space = line.IndexOf(' ');
        return space < 0 ? (line, string.Empty) : (line[..space], line[(space + 1)..].Trim());
    }

    /// <summary>格式化一条命令（/help、列表共用）：<c>  /name [参数提示] —— 描述</c>。</summary>
    public static string Format(SlashCommand command)
        => $"  /{command.Name}{(command.ArgumentHint is { } hint ? " " + hint : "")} —— {command.Description}";

    /// <summary>由注册表推导 /help 文本（不再硬编码），内置 + 用户命令统一列出。</summary>
    public string BuildHelp() => "可用命令：\n" + string.Join("\n", List().Select(Format));
}