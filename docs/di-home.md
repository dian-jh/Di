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

## 安装与升级

`install.ps1` 管理 `bin/` 启动脚本、`ts-cli/` 当前运行时和 `ts-cli.previous/` 上一版。
工作区包只安装 `package.json` 与 `dist/`，第三方运行依赖完整复制，源码、测试及本机测试产物不进入安装。

安装器持有 `.di-install.lock` 的独占文件句柄，拒绝同一目录的并发安装；锁文件可以保留，句柄在退出时释放。
新版本先写入独立暂存目录，以隔离 `DI_HOME` 执行 `--info`。验证成功后才切换运行时和启动脚本，
最后更新 PATH。复制或验证失败不会替换旧版；切换或 PATH 更新失败时恢复旧运行时及启动脚本。
移动操作拒绝已存在的目标，避免把备份误放进未能清理的目录。

成功升级保留上一版运行时；备份轮换或清理失败会告警，不破坏已经启用的新版本。若系统阻止恢复，
错误会列出恢复问题，原备份保留供排查。此流程处理可捕获的安装失败，不承诺断电或强制终止时多个目录
同时切换。配置、凭据、会话、skills、commands 和无关启动脚本不属于安装器替换范围。
回归测试在 `packages/coding-agent/test/cli/install-runtime.test.ts`。

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
