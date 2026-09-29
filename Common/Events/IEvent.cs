namespace Common.Events;

/// <summary>
/// 事件标记接口：所有能通过总线发布 / 订阅 / 消费的事件都实现它。
/// 业务事件直接继承 <see cref="Event"/>（自带 Id / 时间戳 / 关联 ID），
/// 或在无需这些字段时自行实现本接口。
/// </summary>
public interface IEvent
{
}
