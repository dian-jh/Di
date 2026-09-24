namespace Core.Llm;

/// <summary>
/// 消息角色。适配器在翻译层映射到自己的线格式。
/// 参考：DSH 的 <c>MessageSource</c> 归一化角色。
/// </summary>
public enum ChatRole
{
    System,
    User,
    Assistant,
    Tool,
}
