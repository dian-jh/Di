# Di

Di 是本地编程助手，当前提供 TypeScript CLI（`di-ts`）和现有 C# CLI（`di`）。迁移发布门槛完成前，两者并行安装。

## Install the TypeScript CLI

需要 Node.js 22.19 或更新版本以及 npm。在仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会构建 TypeScript workspace，将私有运行时安装到 `~/.di/ts-cli`，并在 `~/.di/bin` 创建 `di-ts` 启动器。它会保留已有的 `~/.di/bin/di` 或 `di.exe`，不会迁移或改写配置、会话、skills、commands 或凭据。默认会将 `~/.di/bin` 加入用户 PATH，之后请打开新终端。使用 `-SkipPathUpdate` 可保持 PATH 不变。

只构建而不安装：

```powershell
npm ci
npm run build
node .\packages\coding-agent\dist\cli\main.js --info
```

使用 `di-ts` 启动 TypeScript CLI。迁移发布门槛完成前，普通 `di` 命令仍指向现有 C# CLI。

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

不要将 API 密钥提交到仓库。由于尚未启用跨进程 OS advisory lock，TypeScript 的 ChatGPT 凭据存储当前会安全失败关闭；生产模型路由也尚未接入 ChatGPT。因此此 CLI 暂不支持 ChatGPT 登录或调用。配置与数据目录见 [`docs/di-home.md`](docs/di-home.md)。

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
