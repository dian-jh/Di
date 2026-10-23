# Di

Di 是本地编程助手，后续开发以 TypeScript 为主线，CLI 命令为 `di-ts`。C# 分支保留作为行为参考和回退；迁移发布门槛完成前，`di-ts` 与既有 C# 命令 `di` 并行安装。

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

安装脚本会构建 TypeScript workspace，将私有运行时安装到 `~/.di/ts-cli`，并在 `~/.di/bin` 创建 `di-ts` 启动器。它会保留已有的 `~/.di/bin/di` 或 `di.exe`，不会迁移或改写配置、会话、skills、commands 或凭据。Windows 默认将 `~/.di/bin` 加入用户 PATH，之后请打开新终端；使用 `-SkipPathUpdate` 可保持 PATH 不变。POSIX 设置启动器执行权限并打印 PATH 指令，不改写 shell profile。

只构建而不安装：

```powershell
npm ci
npm run build
node .\packages\coding-agent\dist\cli\main.js --info
```

使用 `di-ts` 启动 TypeScript CLI。迁移发布门槛完成前，普通 `di` 命令仍指向现有 C# CLI。

已有 C# `di` 且 TS 已并行安装时，显式入口切换和回退工具为 `tools/select-cli.ps1 -Runtime typescript|csharp -DiHome <目录>`。它保留原启动器并校验备份；正式切换前请核对[发布验收状态](docs/migration/typescript-core/progress.md)。安装脚本不会自动选择默认实现，详细行为见[安装与回退](docs/migration/typescript-core/validation-and-release.md#安装切换用户数据与回退)。

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
