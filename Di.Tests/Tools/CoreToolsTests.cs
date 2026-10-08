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
        ["read_file", "write_file", "edit_file", "glob", "grep", "bash", "python"];

    private static readonly string? PythonExe = TestEnvironment.FindPython();

    private readonly string _base = Directory.CreateTempSubdirectory("di-core-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_base, recursive: true); } catch { }
    }

    [Fact]
    public void Create_ReturnsSevenTools_WithUniqueNames()
    {
        var tools = CoreTools.Create(_base);

        Assert.Equal(7, tools.Count);
        Assert.Equal(7, tools.Select(t => t.Name).Distinct().Count());
        Assert.True(ExpectedNames.All(n => tools.Any(t => t.Name == n)),
            $"缺少工具: {string.Join(", ", ExpectedNames.Where(n => tools.All(t => t.Name != n)))}");
    }

    [Fact]
    public void Definitions_Names_MatchTools()
    {
        var tools = CoreTools.Create(_base);
        var definitions = CoreTools.Definitions(_base);

        Assert.Equal(tools.Count, definitions.Count);
        Assert.Equal(tools.Select(t => t.Name), definitions.Select(d => d.Name));
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
        using var executor = CoreTools.CreateExecutor(_base, PythonExe);
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
        var text = CoreTools.Instructions;

        Assert.Contains("read_file", text);
        Assert.Contains("write_file", text);
        Assert.Contains("edit_file", text);
        Assert.Contains("glob", text);
        Assert.Contains("grep", text);
        Assert.Contains("bash", text);
        Assert.Contains("python", text);
    }

    [Fact]
    public void Instructions_StatesEditFileUniquenessRule()
    {
        // 第五章：edit_file 要求 old_string 唯一匹配，否则报错——说明文本应提醒模型。
        Assert.Contains("唯一", CoreTools.Instructions);
    }

    private static ToolCallBlock Call(string name, string arguments) => new("test-1", name, arguments);
}
