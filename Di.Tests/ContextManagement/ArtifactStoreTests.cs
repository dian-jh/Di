using Core.ContextManagement;

namespace Di.Tests.ContextManagement;

/// <summary>
/// <see cref="ArtifactStore"/> 落盘约定测试：§7.1 artifacts 目录布局
/// （~/.di/sessions/YYYY/MM/DD/artifacts/）+ 文件名 / 内容往返。
/// </summary>
public sealed class ArtifactStoreTests
{
    [Fact]
    public void ArtifactsDirectory_DerivesDayPath_UnderSessionsRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), "di-cm-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var store = new ArtifactStore(root, new DateTimeOffset(2026, 10, 15, 8, 30, 0, TimeSpan.Zero));

            var expected = Path.Combine(root, "sessions", "2026", "10", "15", "artifacts");
            Assert.Equal(expected, store.ArtifactsDirectory);
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Write_CreatesTxtFileWithToolName_AndRoundTripsContent()
    {
        var root = Path.Combine(Path.GetTempPath(), "di-cm-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var store = new ArtifactStore(root, new DateTimeOffset(2026, 10, 15, 8, 30, 0, TimeSpan.Zero));
            var content = "line1\nline2\n" + new string('X', 5_000);

            var path = store.Write("bash", content);

            Assert.True(File.Exists(path));
            Assert.StartsWith("tool-bash-", Path.GetFileName(path));
            Assert.EndsWith(".txt", path);
            Assert.Equal(content, File.ReadAllText(path));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Write_DifferentCalls_ProduceDistinctFiles()
    {
        var root = Path.Combine(Path.GetTempPath(), "di-cm-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var store = new ArtifactStore(root, new DateTimeOffset(2026, 10, 15, 8, 30, 0, TimeSpan.Zero));

            var a = store.Write("read_file", "aaa");
            var b = store.Write("read_file", "bbb");

            Assert.NotEqual(a, b);
            Assert.Equal(2, Directory.GetFiles(store.ArtifactsDirectory, "*.txt").Length);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Write_UnsafeToolName_IsSanitizedForFileName()
    {
        var root = Path.Combine(Path.GetTempPath(), "di-cm-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var store = new ArtifactStore(root, new DateTimeOffset(2026, 10, 15, 8, 30, 0, TimeSpan.Zero));

            var path = store.Write("a/b\\c:d*e?f\"g<h>i", "x");

            var name = Path.GetFileName(path);
            Assert.DoesNotContain(Path.GetInvalidFileNameChars(), name);
            Assert.StartsWith("tool-", name);
            Assert.Equal("x", File.ReadAllText(path));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}