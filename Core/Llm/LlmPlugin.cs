using Core.Plugin;

namespace Core.Llm;

/// <summary>
/// 模型层插件：向宿主提供 <see cref="ILlmService"/>。
/// 其它插件通过 <c>ctx.Get&lt;ILlmService&gt;()</c> 使用模型层 ——
/// 这就是"everything is a plugin"：模型层是宿主里的一个服务插件，可被替换。
/// </summary>
public sealed class LlmPlugin : IPlugin
{
    public string Name => "llm";

    public void Apply(IPluginContext context)
    {
        context.Provide<ILlmService>(new LlmRuntime());
    }
}
