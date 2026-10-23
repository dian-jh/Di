# Di

Di 是本地编程助手，TypeScript CLI 是当前全局 `di` 命令的目标实现。C# 源码分支保留作为行为参考；默认安装仍可并行保留旧启动器，显式迁移时可将 `di` 切到 TypeScript 并清除受管理的 C# 发布启动器。

## Install the TypeScript CLI

需要 Node.js 22.19 或更新版本以及 npm。在仓库根目录运行（Windows）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

macOS/Linux 安装脚本需要 PowerShell 7（`pwsh`）：

```sh
pwsh -NoProfile -File ./install.ps1
export PATH="$HOME/.di/bin:$PATH"
```

安装脚本会构建 TypeScript workspace，将私有运行时安装到 `~/.di/ts-cli`，并在 `~/.di/bin` 创建 `di-ts` 启动器。显式迁移命令 `-UseAsDefault -RemoveCSharp` 会在 TS `--info` smoke 成功后令全局 `di` 启动 TypeScript，并删除 `bin` 下的旧 C# 启动包；它不会修改配置、会话、skills、commands、凭据或无关 bin 文件。Windows 默认将 `~/.di/bin` 加入用户 PATH，之后请打开新终端；使用 `-SkipPathUpdate` 可保持 PATH 不变。POSIX 设置启动器执行权限并打印 PATH 指令，不改写 shell profile。

只构建而不安装：

```powershell
npm ci
npm run build
node .\packages\coding-agent\dist\cli\main.js --info
```

使用 `di-ts` 启动 TypeScript CLI；显式迁移后，`di` 与 `di-ts` 都启动 TypeScript CLI。

在 Windows PowerShell 中显式安装为默认命令并清理旧 C# 启动器：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -UseAsDefault -RemoveCSharp
```

POSIX 使用 `pwsh -NoProfile -File ./install.ps1 -UseAsDefault -RemoveCSharp`。

此命令只处理 `~/.di/bin` 中的已知旧 C# 启动器：Windows 的 `di.exe`、`di`、`di.exe.bak-*`、`di-csharp.exe`，或 POSIX 的 `di-csharp`（POSIX `di` 会被替换为 TS shim）；不会移除仓库 C# 源码或无关 exe。该显式清理会删除旧 selector 状态，因此之后不能用 selector 回退，需重新部署 C# 发行包。详见[安装与命令切换](docs/migration/typescript-core/validation-and-release.md#安装与命令切换)。

## Use

```text
di-ts --info
di-ts --help
di-ts --list-models
di-ts --mode json "Summarize this repository"
di-ts --print "Explain this function"
```

默认交互模式在可用时使用 TypeScript TUI。`--mode rpc` 用作 TUI 后端。CLI 模式、退出码和会话恢复行为见 [`docs/cli.md`](docs/cli.md)。

## Configure a provider

TypeScript CLI 按默认值、`~/.di/config.json`、`<workspace>/.di/config.json` 的顺序加载配置，环境变量优先级最高。使用 DeepSeek 时，设置 `DEEPSEEK_API_KEY`，或在用户配置中添加密钥：

```json
{
  "DeepSeek": { "ApiKey": "your-key" }
}
```

不要将 API 密钥提交到仓库。TypeScript CLI 已接入 ChatGPT OAuth 登录、令牌刷新和生产模型调用：

```text
di-ts auth chatgpt login
di-ts auth chatgpt status
di-ts auth chatgpt models
di-ts --provider chatgpt --model <返回的slug> "检查项目"
```

凭据更新使用跨进程原生锁保护。认证行为见 [`docs/modules/chatgpt.md`](docs/modules/chatgpt.md)，配置与数据目录见 [`docs/di-home.md`](docs/di-home.md)。

## Sessions and reference implementation

TypeScript CLI 默认将会话日志写入 `~/.di/sessions/`；设置 `DI_HOME` 可更换数据根目录。迁移期间以 C# 实现作为行为参考，固定基线为 `09f4e0816c1b2dc42461e79a968b46e811d3880c`。迁移状态与未完成的发布门槛见 [`docs/migration/typescript-core/progress.md`](docs/migration/typescript-core/progress.md)。

## Development

```powershell
npm run build
npm run typecheck
npm test
npm run test:compat
```

`npm run test:compat` 还需单独构建好的 workspace 包；先运行 `npm run build`。它执行固定 C# 基线的双向 session 兼容探针，以及本地 HTTP SSE provider→loop→session store 探针，不访问真实 provider。

C# solution 和原有行为文档继续保留供参考。项目文档索引从 [`docs/README.md`](docs/README.md) 开始。
