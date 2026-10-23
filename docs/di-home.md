# `~/.di` 与配置

`packages/coding-agent/src/core/config/di-home.ts` 的 `DiHome` 计算用户数据路径。默认根目录为
用户家目录下的 `.di`；非空 `DI_HOME` 会原样用作根路径（相对值不会自动转成绝对路径）。

## 目录布局

| 路径 | 用途 |
|---|---|
| `config.json` | 用户级配置，只读加载，不由 CLI 自动改写 |
| `sessions/` | session JSONL 与按日期组织的工具输出 artifacts |
| `logs/` | 运行日志 |
| `skills/`、`commands/` | 用户技能与斜杠命令 |
| `auth/chatgpt/` | ChatGPT OAuth 凭据与锁文件 |
| `mcp.json` | MCP 配置路径入口 |

工作区配置在 `<workspace>/.di/config.json`。路径 getter 定义在 `DiHome`；session 落盘由
`packages/coding-agent/src/core/sessions/session-log.ts` 的 `SessionStore` 实现，认证存储由
`packages/coding-agent/src/core/auth/credential-store.ts` 实现。

## 合并顺序与格式

`packages/coding-agent/src/core/config/di-config.ts` 的 `DiConfig.load` 按以下顺序合并：

1. 程序默认值
2. `~/.di/config.json`
3. `<workspace>/.di/config.json`
4. 环境变量

后加载的同名键覆盖先前值。对象递归展平后按 `:` 分隔路径合并，查找键不区分大小写；环境变量
中的双下划线 `__` 转为层级分隔符，单下划线保留。配置文件使用 JSONC，可带注释和尾逗号；根
元素必须是对象。配置读取与解析入口分别为 `packages/coding-agent/src/core/config/di-config.ts` 和
`packages/coding-agent/src/core/config/jsonc.ts`。

常用配置示例：

```jsonc
{
  "Model": {
    "Provider": "deepseek",
    "DefaultModel": "deepseek-flash"
  },
  "DeepSeek": {
    "DefaultReasoningEffort": "high",
    "StrictTools": false,
    "UseSystemProxy": false,
    "TimeoutSeconds": 60,
    "StreamIdleTimeoutSeconds": 60
  },
  "AgentLoop": {
    "MaxIterations": 0,
    "HistoryBudgetRatio": 0.5,
    "ReasoningEffort": "high",
    "MaxTokens": 8192,
    "SystemPrompt": ""
  },
  "ContextManagement": {
    "Enabled": true
  }
}
```

`MaxTokens` 和 `SystemPrompt` 为可选项；`MaxIterations=0` 表示不设迭代上限。宿主未配置
provider/model 时使用 `deepseek` / `deepseek-flash`。DeepSeek API key 可由 `DEEPSEEK_API_KEY`
提供。CLI 参数 `--provider`、`--model`、`--thinking` 覆盖对应运行值。环境变量可用双下划线表示
层级，例如 `AGENTLOOP__MAXITERATIONS`。完整字段读取点见
`packages/coding-agent/src/cli/cli-host-compose.ts` 与
`packages/coding-agent/src/cli/provider-runtime.ts`。
