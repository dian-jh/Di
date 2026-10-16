namespace Core.Llm;

/// <summary>A provider route and its opaque model ID. Only known provider prefixes are split.</summary>
public sealed record ModelReference(string Provider, string Id)
{
    public string QualifiedId => $"{Provider}/{Id}";

    public static ModelReference Parse(string text, string defaultProvider, IEnumerable<string> providers)
    {
        text = text.Trim();
        if (text.Length == 0) throw new ArgumentException("Model must not be empty.", nameof(text));
        var slash = text.IndexOf('/');
        var provider = slash > 0 ? providers.FirstOrDefault(p => p.Equals(text[..slash], StringComparison.OrdinalIgnoreCase)) : null;
        if (provider is null) return new(defaultProvider, text);
        if (slash == text.Length - 1) throw new ArgumentException("Model ID must not be empty.", nameof(text));
        return new(provider, text[(slash + 1)..]);
    }
}
