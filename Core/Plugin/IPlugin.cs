namespace Core.Plugin;

/// <summary>
/// 插件契约。对应 DSH 的 <c>export function apply(ctx, config)</c> + <c>export const inject</c>。
///
/// 设计要点：插件通过 <see cref="Apply"/> 的<b>副作用</b>把自己挂到宿主上，
/// 而不是被某处显式 new 出来。所有注册都必须经过 <see cref="IPluginContext"/>，
/// 这样卸载插件时才能干净撤销（这是"everything is a plugin"的基础）。
/// </summary>
public interface IPlugin
{
    /// <summary>插件名，用于日志与诊断。</summary>
    string Name { get; }

    /// <summary>
    /// 声明本插件需要的服务键。宿主保证这些服务全部就绪后才调用 <see cref="Apply"/>。
    /// 对应 DSH 的 <c>export const inject = ['llm']</c>。
    /// </summary>
    IReadOnlyList<string> Inject => [];

    /// <summary>
    /// 副作用注册阶段。<b>必须同步且不阻塞</b>：这里只应注册服务与回调，
    /// 需要 I/O 的初始化请放进 <see cref="IStartup"/>。
    /// </summary>
    void Apply(IPluginContext context);
}

/// <summary>
/// 需要异步初始化的插件额外实现这个接口。宿主在全部插件 <see cref="IPlugin.Apply"/> 完成后调用。
/// </summary>
public interface IStartup
{
    Task StartAsync(CancellationToken cancellationToken);
}
