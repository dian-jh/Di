namespace Core.Tools;

/// <summary>
/// 进程生命周期诊断钩子：<see cref="ProcessRunner"/> 在 spawn / 超时 / 退出时发旁路诊断行
/// （<c>proc: start / running / timeout / exited</c>），默认 no-op，绝不抛异常——与运行日志
/// "旁路观察"哲学一致（docs/modules/logging.md）。
///
/// 事件总线订阅不到工具内部（进程级细节不在回合生命周期事件里），这里用静态钩子单向注入，
/// 避免把总线穿过 Executor → ICoreTool → ProcessRunner 每条调用链。宿主（Di.Cli/CliHost.cs）
/// 设置为 <c>msg =&gt; diLog.Log(LogLevel.Info, msg)</c>。
/// </summary>
public static class ProcessDiagnostics
{
    /// <summary>诊断行接收器（null = 关闭）。写到这里的内容不保证幂等，接收方必须自行兜底。</summary>
    public static Action<string>? Log { get; set; }
}