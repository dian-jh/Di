using Core.AgentLoop;
using Core.Llm;
using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>
/// 针对 <see cref="CoreTools"/> 聚合（七个核心工具 + 稳定前缀说明）的测试。
/// 覆盖：工具数量与命名唯一、Definition 一致、executor 分发（写→读回环）、未知工具、说明文本覆盖全部工具。
/// </summary>
public sealed class CoreToolsTests : IDisposable
{
    private static readonly string[] ExpectedNames =
        ["read_file", "write_file", "edit_file", "glob", "grep", "bash", "powershell", "python"];

    private static readonly string? PythonExe = TestEnvironment.FindPython();

    private readonly string _base = Directory.CreateTempSubdirectory("di-core-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_base, recursive: true); } catch { }
    }

    [Fact]
    public void CreateTools_ReturnsEightTools_WithUniqueNames()
    {
        var tools = CoreTools.CreateTools(_base);

        Assert.Equal(8, tools.Count);
        Assert.Equal(8, tools.Select(t => t.Name).Distinct().Count());
        Assert.True(ExpectedNames.All(n => tools.Any(t => t.Name == n)),
            $"缺少工具: {string.Join(", ", ExpectedNames.Where(n => tools.All(t => t.Name != n)))}");
    }

    [Fact]
    public void Definitions_Names_MatchTools()
    {
        var tools = CoreTools.CreateTools(_base);
        var definitions = CoreTools.Definitions(_base);

        Assert.Equal(tools.Count, definitions.Count);
        Assert.Equal(tools.Select(t => t.Name), definitions.Select(d => d.Name));
    }

    // ---- 注册与路由（对应 pi index.ts 的 createTool / 工具集组合）----

    [Fact]
    public void CreateTool_UnknownName_Throws()
    {
        Assert.Throws<InvalidOperationException>(() => CoreTools.CreateTool("no_such_tool", _base));
    }

    [Fact]
    public void CreateTool_ReadFileOptions_OverrideMaxBytes()
    {
        var tool = CoreTools.CreateTool("read_file", _base, new CoreTools.Options
        {
            ReadFile = new CoreTools.ReadFileOptions { MaxBytes = 10 },
        });
        File.WriteAllText(Path.Combine(_base, "big.txt"), new string('x', 100));

        var result = tool.ExecuteAsync("""{"path":"big.txt"}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
        Assert.Contains("过大", result);
    }

    [Fact]
    public void CreateTools_WithToolNames_BuildsOnlyThatSubset()
    {
        var tools = CoreTools.CreateTools(_base, toolNames: CoreTools.ReadOnlyToolNames);

        Assert.Equal(["read_file", "glob", "grep"], tools.Select(t => t.Name).ToArray());
    }

    [Fact]
    public void CreateReadOnlyTools_ExcludesMutations()
    {
        var tools = CoreTools.CreateReadOnlyTools(_base);

        Assert.DoesNotContain(tools, t => t.Name is "write_file" or "edit_file" or "bash" or "powershell" or "python");
    }

    [Fact]
    public void CreateCodingTools_ExcludesSearchAndPython()
    {
        var tools = CoreTools.CreateCodingTools(_base);

        Assert.Equal(["read_file", "write_file", "edit_file", "bash"], tools.Select(t => t.Name).ToArray());
    }

    [Fact]
    public void Definitions_RespectToolNames_Subset()
    {
        var definitions = CoreTools.Definitions(_base, toolNames: CoreTools.ReadOnlyToolNames);

        Assert.Equal(["read_file", "glob", "grep"], definitions.Select(d => d.Name).ToArray());
    }

    [Fact]
    public void AllToolNames_ContainsAllEight()
    {
        Assert.Equal(8, CoreTools.AllToolNames.Count);
        Assert.True(ExpectedNames.All(CoreTools.AllToolNames.Contains));
    }

    [Fact]
    public void CreateTool_PowerShell_IsOneShotWithoutSession()
    {
        // 直接创建（无会话）→ 一次性模式：Definition 保留 working_dir。
        var tool = CoreTools.CreateTool("powershell", _base);

        Assert.Equal("powershell", tool.Name);
        Assert.True(tool.Definition.Parameters["properties"]!.AsObject().ContainsKey("working_dir"));
    }

    [Fact]
    public async Task Executor_WriteThenRead_RoundTrips()
    {
        var executor = CoreTools.CreateExecutor(_base);
        var written = await executor.ExecuteAsync(Call("write_file",
            $$"""{"path":"a.txt","content":"hello world"}"""));

        Assert.Contains("OK", written);
        var read = await executor.ExecuteAsync(Call("read_file", """{"path":"a.txt"}"""));

        Assert.Contains("hello world", read);
    }

    [Fact]
    public async Task Executor_GlobFindsWrittenFile()
    {
        var executor = CoreTools.CreateExecutor(_base);
        await executor.ExecuteAsync(Call("write_file", """{"path":"data/x.cs","content":"// x"}"""));

        var glob = await executor.ExecuteAsync(Call("glob", """{"pattern":"**/*.cs"}"""));

        Assert.Contains("data/x.cs", glob);
    }

    [Fact]
    public async Task Executor_GrepFindsWrittenContent()
    {
        var executor = CoreTools.CreateExecutor(_base);
        await executor.ExecuteAsync(Call("write_file", """{"path":"src/api.cs","content":"public void Run() { }\n// TODO: fix\n"}"""));

        var grep = await executor.ExecuteAsync(Call("grep", """{"pattern":"TODO"}"""));

        Assert.Contains("src/api.cs:2: // TODO: fix", grep);
    }

    [Fact]
    public async Task Executor_BashRunsCommand()
    {
        using var executor = CoreTools.CreateExecutor(_base);
        var result = await executor.ExecuteAsync(Call("bash", """{"command":"echo core-bash"}"""));

        Assert.Contains("core-bash", result);
    }

    [Fact]
    public async Task Executor_PowerShell_RunsCommand()
    {
        using var executor = CoreTools.CreateExecutor(_base);
        var result = await executor.ExecuteAsync(Call("powershell", """{"command":"Write-Output core-ps"}"""));

        Assert.Contains("core-ps", result);
    }

    [Fact]
    public async Task Executor_PowerShell_PersistentSession_StatePersists()
    {
        // 与 bash 一致：powershell 在共享持久化会话中运行——第一次 cd 的状态在后续调用中保持。
        Directory.CreateDirectory(Path.Combine(_base, "work"));
        using var executor = CoreTools.CreateExecutor(_base);

        await executor.ExecuteAsync(Call("powershell", """{"command":"cd work"}"""));
        var result = await executor.ExecuteAsync(Call("powershell", """{"command":"(Get-Location).Path"}"""));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("work", result);
    }

    [Fact]
    public void Definitions_PowerShellIsPersistentSession_OmitsWorkingDir()
    {
        // Definitions 与 CreateExecutor 一致：powershell 是持久化会话模式，schema 里没有 working_dir。
        var def = CoreTools.Definitions(_base).Single(d => d.Name == "powershell");

        Assert.NotNull(def.Parameters["properties"]!["command"]);
        Assert.False(def.Parameters["properties"]!.AsObject().ContainsKey("working_dir"));
        Assert.Contains("持久化", def.Description);
    }

    [Fact]
    public async Task Executor_Bash_PersistentSession_StatePersists()
    {
        // 第五章：共享持久化终端会话是 bash 的默认模式——第一次 cd 的状态在后续调用中保持。
        Directory.CreateDirectory(Path.Combine(_base, "work"));
        using var executor = CoreTools.CreateExecutor(_base);

        await executor.ExecuteAsync(Call("bash", """{"command":"cd work"}"""));
        var result = await executor.ExecuteAsync(Call("bash",
            OperatingSystem.IsWindows() ? """{"command":"cd"}""" : """{"command":"pwd"}"""));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("work", result);
    }

    [Fact]
    public void Definitions_BashIsPersistentSession_OmitsWorkingDir()
    {
        // Definitions 与 CreateExecutor 一致：bash 是持久化会话模式，schema 里没有 working_dir。
        var def = CoreTools.Definitions(_base).Single(d => d.Name == "bash");

        Assert.NotNull(def.Parameters["properties"]!["command"]);
        Assert.False(def.Parameters["properties"]!.AsObject().ContainsKey("working_dir"));
    }

    [Fact]
    public async Task Executor_PythonRunsCode()
    {
        if (PythonExe is null) return;
        using var executor = CoreTools.CreateExecutor(_base, new CoreTools.Options
        {
            Python = new CoreTools.PythonOptions { Executable = PythonExe },
        });
        var result = await executor.ExecuteAsync(Call("python", """{"code":"print(3 + 4)"}"""));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("7", result);
    }

    [Fact]
    public async Task Executor_UnknownTool_ReturnsError()
    {
        var executor = CoreTools.CreateExecutor(_base);
        var result = await executor.ExecuteAsync(Call("no_such_tool", """{}"""));

        Assert.StartsWith("error:", result);
        Assert.Contains("未知工具", result);
    }

    [Fact]
    public void Instructions_MentionsAllToolNames()
    {
        var text = CoreTools.BuildInstructions(_base);

        Assert.Contains("read_file", text);
        Assert.Contains("write_file", text);
        Assert.Contains("edit_file", text);
        Assert.Contains("glob", text);
        Assert.Contains("grep", text);
        Assert.Contains("bash", text);
        Assert.Contains("powershell", text);
        Assert.Contains("python", text);
    }

    [Fact]
    public void Instructions_StatesEditFileUniquenessRule()
    {
        // 第五章：edit_file 要求 old_string 唯一匹配，否则报错——说明文本应提醒模型。
        Assert.Contains("唯一", CoreTools.BuildInstructions(_base));
    }

    [Fact]
    public void BuildInstructions_ContainsToolListAndRulesSections()
    {
        var text = CoreTools.BuildInstructions(_base);

        Assert.Contains("工具：", text);
        Assert.Contains("规则：", text);
    }

    [Fact]
    public void BuildInstructions_ToolListFollowsCanonicalOrder()
    {
        var text = CoreTools.BuildInstructions(_base);

        var order = new[] { "read_file", "write_file", "edit_file", "glob", "grep", "bash", "powershell", "python" };
        var positions = order.Select(name => text.IndexOf(name, StringComparison.Ordinal)).ToArray();
        for (var i = 1; i < positions.Length; i++)
            Assert.True(positions[i - 1] < positions[i], $"工具清单顺序错乱：{order[i - 1]} 应排在 {order[i]} 之前");
    }

    [Fact]
    public void BuildInstructions_AggregatesGlobalAndPerToolRules()
    {
        var text = CoreTools.BuildInstructions(_base);

        // 全局规则（跨工具约定）
        Assert.Contains("观察结果以", text);
        Assert.Contains("exit: N", text);
        Assert.Contains("回答要简洁", text);

        // 各工具贡献的规则（与 schema 同源，co-locate 在工具定义文件里）
        Assert.Contains("先读再动", text);                                  // read_file
        Assert.Contains("old_string 必须唯一", text);                       // edit_file
        Assert.Contains("不要编造文件内容", text);                           // grep
        Assert.Contains("切换目录用 cd 而不是 working_dir", text);           // bash
        Assert.Contains("切换目录用 cd（Set-Location）", text);              // powershell
    }

    [Fact]
    public void EveryTool_ProvidesPromptSnippetAndGuidelines()
    {
        var tools = CoreTools.CreateTools(_base);

        Assert.All(tools, tool =>
        {
            Assert.False(string.IsNullOrWhiteSpace(tool.PromptSnippet), $"{tool.Name} 缺少 PromptSnippet");
            Assert.NotNull(tool.PromptGuidelines);
            Assert.All(tool.PromptGuidelines, g => Assert.False(string.IsNullOrWhiteSpace(g)));
        });
    }

    private static ToolCallBlock Call(string name, string arguments) => new("test-1", name, arguments);
}
