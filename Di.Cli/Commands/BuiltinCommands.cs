using Core.Skills;

namespace Di.Cli.Commands;

/// <summary>
/// 内置斜杠命令（模式无关：只经 <see cref="CommandContext"/> 访问能力，REPL 与 RPC 共用同一份）。
/// 行为逐条对齐旧 <c>Repl.RunCommandAsync</c> 的 switch，回归由 <c>ReplTests</c> 保障。
/// </summary>
public static class BuiltinCommands
{
    /// <summary>创建含全部内置命令的注册表。</summary>
    public static SlashCommandRegistry CreateRegistry()
    {
        var registry = new SlashCommandRegistry();
        registry.RegisterAll(Create());
        return registry;
    }

    public static IReadOnlyList<SlashCommand> Create() =>
    [
        new("exit", "退出 Di", null, (_, _) => Task.FromResult(CommandResult.Quit)),

        new("help", "显示命令帮助", null, (_, ctx) =>
        {
            ctx.Output.WriteLine(ctx.Registry.BuildHelp());
            return Task.FromResult(CommandResult.Handled);
        }),

        new("clear", "清空屏幕与对话记忆", null, (_, ctx) =>
        {
            if (ctx.UseAnsi)
                ctx.Output.Write("\x1b[2J\x1b[H");   // ANSI 清屏（主屏幕）；重定向/RPC 下省略
            ctx.Runner.ResetHistory();
            ctx.Output.WriteLine("已清空屏幕与对话记忆");
            return Task.FromResult(CommandResult.Handled);
        }),

        new("model", "查看或切换模型", "[provider/model | 名称 | --refresh]", async (args, ctx) =>
        {
            if (ctx.Models is null)
            {
                ctx.Output.WriteLine("宿主未提供模型选择器。");
                return CommandResult.Handled;
            }
            try
            {
                if (args is "" or "--refresh")
                {
                    if (args == "--refresh")
                        foreach (var error in await ctx.Models.RefreshAsync(ctx.CancellationToken)) ctx.Output.WriteLine(error);
                    ctx.Output.WriteLine($"当前模型: {ctx.Models.Current.QualifiedId}");
                    foreach (var model in ctx.Models.List()) ctx.Output.WriteLine($"  {model.Provider}/{model.Id}  {model.Name}");
                    ctx.Output.WriteLine("用法: /model <provider/model 或唯一名称>；/model --refresh 刷新目录。");
                }
                else
                {
                    await ctx.Models.SelectAsync(args, ctx.CancellationToken);
                    ctx.Output.WriteLine($"模型已切换为 {ctx.Runner.CurrentModel}");
                }
            }
            catch (Exception ex) when (ex is ArgumentException or Core.Llm.LlmException or IOException)
            { ctx.Output.WriteLine(ex.Message); }
            return CommandResult.Handled;
        }),

        new("thinking", "查看或切换推理强度", "[强度 | default]", async (args, ctx) =>
        {
            if (ctx.Models is null) { ctx.Output.WriteLine("宿主未提供模型选择器。"); return CommandResult.Handled; }
            try
            {
                if (args.Length > 0) await ctx.Models.SetReasoningAsync(args, ctx.CancellationToken);
                var model = await ctx.Models.ResolveCurrentAsync(ctx.CancellationToken);
                ctx.Output.WriteLine($"推理强度: {ctx.Models.ReasoningEffort ?? (model.Reasoning?.DefaultEffort is { } d ? $"default ({d})" : "default")}");
                ctx.Output.WriteLine(model.Reasoning is { } r ? "支持档位: " + string.Join(", ", r.Efforts.Select(e => e.Id)) :
                    "目录未提供模型专属档位，实际支持情况由模型校验。");
            }
            catch (Exception ex) when (ex is ArgumentException or Core.Llm.LlmException) { ctx.Output.WriteLine(ex.Message); }
            return CommandResult.Handled;
        }),

        new("usage", "查看 ChatGPT 订阅额度入口", null, (_, ctx) =>
        {
            ctx.Output.WriteLine("ChatGPT 官方额度: https://chatgpt.com/settings/usage");
            ctx.Output.WriteLine("此官方 OAuth 接口未公开五小时/每周剩余额度查询，无法在本地准确显示；请以账户 Usage 页面为准。");
            ctx.Output.WriteLine("本地 tokens/cache_read/cache_write 是请求计量，不代表订阅剩余额度。");
            return Task.FromResult(CommandResult.Handled);
        }),

        new("skills", "列出可用 skill（固定激活的以 * 标记）", null, (_, ctx) =>
        {
            ListSkills(ctx);
            return Task.FromResult(CommandResult.Handled);
        }),

        new("skill", "激活/停用 skill；带参数一次性执行", "<名称> [参数]", (args, ctx) =>
            Task.FromResult(HandleSkill(args, ctx))),
    ];

    private static void ListSkills(CommandContext ctx)
    {
        if (ctx.Skills.Count == 0)
        {
            ctx.Output.WriteLine("没有可用 skill。把 <名称>/SKILL.md 或 <名称>.md 放在 ~/.di/skills/ 或 <工作区>/.di/skills/ 下。");
            return;
        }
        foreach (var skill in ctx.Skills)
        {
            var marker = ctx.Pinned.Contains(skill) ? "*" : " ";
            ctx.Output.WriteLine($"  [{marker}] {skill.Name} —— {skill.Description}");
        }
    }

    /// <summary>
    /// /skill：无参数显示用法；<c>&lt;名&gt;</c> 切换固定激活；<c>&lt;名&gt; &lt;参数&gt;</c> 一次性执行
    /// ——完整指令 + 参数请求宿主运行一个回合（对齐 Pi 的 /skill:name args），不固定。
    /// </summary>
    private static CommandResult HandleSkill(string args, CommandContext ctx)
    {
        var (name, skillArgs) = SlashCommandRegistry.Split(args);
        if (skillArgs.Length > 0)
        {
            var skill = ctx.Skills.FirstOrDefault(s => s.Name == name);
            if (skill is null)
            {
                ctx.Output.WriteLine($"未找到 skill：{name}（/skills 查看可用列表）");
                return CommandResult.Handled;
            }
            var message = $"【Skill：{skill.Name}】{skill.Description}\n\n{skill.Instructions}\n\n{skillArgs}";
            return CommandResult.Turn(message);
        }
        return ToggleSkill(name, ctx);
    }

    /// <summary>/skill：带名称切换固定激活，off/none 清空固定集，无参数显示当前与用法。</summary>
    private static CommandResult ToggleSkill(string name, CommandContext ctx)
    {
        if (name.Length == 0)
        {
            ctx.Output.WriteLine(ctx.Pinned.Count == 0
                ? "当前未固定任何 skill。用法: /skill <名称> 固定（再输一次停用，/skill off 全部停用）；/skill <名称> <参数> 一次性执行（指令+参数）。匹配到的 skill 也会自动加载。"
                : $"当前已固定：{string.Join("、", ctx.Pinned.Select(s => s.Name))}。用法: /skill <名称> 切换；/skill <名称> <参数> 一次性执行。");
            return CommandResult.Handled;
        }
        if (name is "off" or "none")
        {
            ctx.Pinned.Clear();
            ctx.Runner.ActiveSkills = [.. ctx.Pinned];
            ctx.Output.WriteLine("已停用全部 skill");
            return CommandResult.Handled;
        }
        var skill = ctx.Skills.FirstOrDefault(s => s.Name == name);
        if (skill is null)
        {
            ctx.Output.WriteLine($"未找到 skill：{name}（/skills 查看可用列表）");
            return CommandResult.Handled;
        }
        if (ctx.Pinned.Contains(skill))
        {
            ctx.Pinned.Remove(skill);
            ctx.Output.WriteLine($"已停用 skill：{skill.Name}");
        }
        else
        {
            ctx.Pinned.Add(skill);
            ctx.Output.WriteLine($"已激活 skill：{skill.Name}");
        }
        ctx.Runner.ActiveSkills = [.. ctx.Pinned];
        return CommandResult.Handled;
    }
}
