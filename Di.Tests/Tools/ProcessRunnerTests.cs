using System.Diagnostics;
using Core.Tools;

namespace Di.Tests.Tools;

public sealed class ProcessRunnerTests
{
    [Fact]
    public async Task RunAsync_ChildKeepsOutputPipeOpen_DrainHasIndependentDeadline()
    {
        var pidFile = Path.GetTempFileName();
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        Task<ProcessResult>? task = null;
        try
        {
            var command = OperatingSystem.IsWindows()
                ? $"$p = Start-Process powershell.exe -ArgumentList '-NoProfile', '-Command', 'Start-Sleep 60' -NoNewWindow -PassThru; [IO.File]::WriteAllText('{pidFile.Replace("'", "''")}', \"$PID,$($p.Id)\"); Write-Output 'parent done'"
                : $"sleep 60 & echo $$,$! > '{pidFile}'; echo 'parent done'";
            task = ProcessRunner.RunAsync(
                OperatingSystem.IsWindows() ? "powershell.exe" : "/bin/sh",
                OperatingSystem.IsWindows() ? ["-NoProfile", "-Command", command] : ["-c", command],
                Path.GetTempPath(), TimeSpan.FromSeconds(90), cancellation.Token);

            // 父进程退出后再计时，排除并发负载下的 shell 启动耗时。
            string[] pids;
            do
            {
                await Task.Delay(20, cancellation.Token);
                pids = File.ReadAllText(pidFile).Trim().Split(',');
            } while (pids.Length != 2 || !int.TryParse(pids[1], out _));
            try
            {
                using var parent = Process.GetProcessById(int.Parse(pids[0]));
                await parent.WaitForExitAsync(cancellation.Token);
            }
            catch (ArgumentException) { }

            var result = await task.WaitAsync(TimeSpan.FromSeconds(5));

            Assert.Equal(0, result.ExitCode);
            Assert.Contains("parent done", result.Output);
        }
        finally
        {
            await cancellation.CancelAsync();
            if (task is not null)
            {
                try { await task; }
                catch (OperationCanceledException) { }
            }
            var pids = File.ReadAllText(pidFile).Trim().Split(',');
            if (pids.Length == 2 && int.TryParse(pids[1], out var pid))
            {
                try { Process.GetProcessById(pid).Kill(entireProcessTree: true); }
                catch (ArgumentException) { }
            }
            File.Delete(pidFile);
        }
    }
}
