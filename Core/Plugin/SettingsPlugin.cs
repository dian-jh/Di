using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Core.Plugin;

/// <summary>
/// 配置服务：从 appsettings.json 的对应段绑定插件配置。
/// 对应 DSH 的 settings 子系统 + <c>export const Config = z.object({...})</c>。
///
/// 每个插件声明自己的配置段（namespace），宿主加载文件后按段注入。
/// </summary>
public interface ISettingsService
{
    /// <summary>读取一个配置段并绑定到 <typeparamref name="T"/>。找不到该段时返回 null。</summary>
    T? GetSection<T>(string sectionName) where T : class;

    /// <summary>读取一个配置段（原始 JSON）。找不到时返回 null。</summary>
    JsonNode? GetSection(string sectionName);
}

/// <summary>
/// 宿主提供的配置服务实现。文件路径默认 <c>appsettings.json</c>（程序目录）。
/// </summary>
public sealed class SettingsService : ISettingsService
{
    private readonly JsonObject? _root;
    private readonly JsonSerializerOptions _options;

    public SettingsService(string? filePath = null, JsonSerializerOptions? options = null)
    {
        var path = filePath ?? Path.Combine(AppContext.BaseDirectory, "appsettings.json");

        if (File.Exists(path))
        {
            try
            {
                _root = JsonNode.Parse(File.ReadAllText(path)) as JsonObject;
            }
            catch (JsonException)
            {
                _root = null;
            }
        }

        _options = options ?? new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            ReadCommentHandling = JsonCommentHandling.Skip,
            AllowTrailingCommas = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };
    }

    public T? GetSection<T>(string sectionName) where T : class
    {
        var node = GetSection(sectionName);
        return node?.Deserialize<T>(_options);
    }

    public JsonNode? GetSection(string sectionName)
    {
        if (_root is null)
            return null;

        return _root[sectionName];
    }
}

/// <summary>
/// 让 settings 成为宿主的第一个服务。用法：
/// <code>
/// host.Provide(new SettingsService());   // 或经插件 Provide
/// </code>
/// 配置段解析在需要时发生（惰性），因此文件不存在也不影响启动。
/// </summary>
public sealed class SettingsPlugin : IPlugin
{
    public string Name => "settings";

    private readonly ISettingsService? _service;

    public SettingsPlugin(ISettingsService? service = null) => _service = service;

    public void Apply(IPluginContext context)
    {
        if (_service is null)
        {
            context.Provide(new SettingsService());
        }
        else
        {
            context.Provide(_service);
        }
    }
}
