namespace Core.Llm;

/// <summary>
/// 默认模型选择（配置段 "Model"）。模型工厂据此选 provider；CLI 启动时把
/// <see cref="DefaultModel"/> 设为当前模型（之后仍可 /model 切换）。
/// </summary>
public sealed class ModelOptions
{
    /// <summary>provider 路由（对应已注册的 ChatAdapter，如 "deepseek"）。</summary>
    public string Provider { get; set; } = "deepseek";

    /// <summary>启动时使用的默认模型名。</summary>
    public string DefaultModel { get; set; } = "deepseek-flash";
}
