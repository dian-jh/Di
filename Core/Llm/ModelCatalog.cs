namespace Core.Llm;

/// <summary>
/// 一条模型目录记录（纯数据，对应 Pi 的模型目录层）。
///
/// 目录是<b>咨询性</b>的：适配器声明它认识的模型及其元数据，供 UI 选择器 / 配置校验 /
/// token 预算 / 成本计量使用。<b>未列入目录的模型 ID 适配器仍可能接受</b>，消费方不得把
/// "不在目录"当成请求拒绝的理由。
///
/// 加模型 = 在适配器的 <see cref="ChatAdapter.Catalog"/> 加一条记录，引擎代码零改动
/// （对应 Pi 的第一条设计决策：模型是纯数据）。
/// </summary>
public sealed record ModelSpec(
    string Id,
    string Name,
    int? ContextWindow = null,
    int? DefaultMaxTokens = null,
    IReadOnlyList<ReasoningEffort>? ReasoningEfforts = null,
    ModelCostRates? Cost = null);
