namespace Core.Plugin;

/// <summary>
/// 插件看到的宿主上下文。对应 Cordis 的 <c>ctx</c>。
///
/// 只暴露三件事：取服务、提供服务、声明式等依赖。
/// 所有返回的 <see cref="IDisposable"/> 都归当前插件的作用域，插件卸载时自动撤销。
/// </summary>
public interface IPluginContext
{
    /// <summary>
    /// 取一个已注册的服务；未注册返回 null，且会登记"本插件依赖该服务"，
    /// 因此该服务之后被注册时会触发相关 <see cref="Inject"/> 回调。
    /// 对应 DSH 的 <c>ctx.get('attachments')</c>。
    /// </summary>
    T? Get<T>() where T : class;

    /// <summary>
    /// 注册一个服务。<b>重复注册同一个服务键会抛异常</b>（对应 DSH 的
    /// <c>DUPLICATE_ADAPTER</c> 一类的注册冲突检查）——静默覆盖会让两个插件
    /// 同时以为自己拥有该服务。
    /// </summary>
    IDisposable Provide<T>(T service) where T : class;

    /// <summary>
    /// 声明式依赖：当 <paramref name="services"/> 全部就绪时调用 <paramref name="callback"/>。
    /// 若此刻已就绪则立即执行。对应 DSH 的 <c>ctx.inject(['settings'], ctx =&gt; …)</c>。
    /// 回调内注册的一切同样归属当前插件作用域。
    /// </summary>
    void Inject(IReadOnlyList<string> services, Action<IPluginContext> callback);

    /// <summary>当前已注册的服务键，用于诊断与错误信息。</summary>
    IReadOnlyCollection<string> Services { get; }

    /// <summary>宿主级取消（进程关闭或宿主释放）。</summary>
    CancellationToken Shutdown { get; }
}
