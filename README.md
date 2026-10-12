# di

简洁的 ReAct 编码助手（harness）——读文件、改代码、跑命令、调用模型。

- **harness 层**（`Core/`）：会话驱动 API（`Core.AgentLoop.AgentRunner`）+ 事件流 + 模型层 + 工具。
- **CLI 层**（`Di.Cli/`）：薄壳——参数解析 / 模式选择 / 渲染，可整体换语言重写（见 `docs/cli.md`）。

## 安装（全局命令 `di`）

在仓库根目录运行：

```bat
:: cmd
install.cmd
```

```powershell
# PowerShell
powershell -ExecutionPolicy Bypass -File install.ps1
```

脚本会 `dotnet publish` 出 win-x64 自包含单文件 `di.exe`（免 .NET 运行时），
复制到 `~/.di/bin/`，并把该目录**幂等**追加到用户 PATH。新开终端后：

```bat
di --version
```

## 用法

> headless / JSON 契约与退出码语义见 `docs/cli.md` §4；本处为面向用户的示例。

```bat
di "读一下 README"                :: headless 单发（文本，跑一个回合即退出）
di --mode json "分析这个函数"       :: headless 单发（JSON 单文档，脚本友好）
echo 总结 | di                    :: 无位置参数时从 stdin 读提示词
di                                :: 交互 REPL（/help /model /skills /clear /exit）
di --list-models                  :: 列出可用模型
di -m deepseek-v4-pro "跑测试"      :: 指定模型 / --provider 指定 provider
di --no-session --no-ansi "x"      :: 脚本友好：不写会话日志、无 ANSI
```

退出码：`0` 成功；`1` 用法错误 / 运行错误（模型不可用等）。

## 配置

> 分层配置与 `~/.di` 家目录的规范定义见 `docs/di-home.md`；本处为面向用户的摘录。

分层 JSON 配置，后加载覆盖先加载：

1. `appsettings.json`（内置默认，随 exe 走）
2. `~/.di/config.json`（用户全局）
3. `<工作区>/.di/config.json`（项目级，随仓库走）
4. 环境变量（运行时覆盖）

API Key：环境变量 `DEEPSEEK_API_KEY`，或写进 `~/.di/config.json`。常用覆盖项：

```json
{
  "DeepSeek": { "ApiKey": "sk-..." },
  "AgentLoop": { "MaxIterations": 24 }
}
```

`AgentLoop:MaxIterations` 是单回合的迭代预算（一次迭代 ≈ 一次模型往返，通常含一次工具调用），
默认 24 轮——复杂分析/测试-修复循环动辄 10-20 轮；DeepSeek 上下文 1M token + 前缀缓存，
放宽上限的边际成本极低。要更宽或更紧（脚本控成本）都可以在这里调。

会话日志默认写入 `~/.di/sessions/YYYY/MM/DD/*.jsonl`。

## 开发

```bat
dotnet test Di.Tests
dotnet test Di.Cli.Tests
```
