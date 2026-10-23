# Di

Di 是以 TypeScript 实现的本地编程助手，CLI 入口由 `@di/coding-agent` 提供。

## 安装

需要 Node.js 22.19 或更新版本以及 npm。在仓库根目录运行（Windows）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

macOS/Linux 需要 PowerShell 7（`pwsh`）：

```sh
pwsh -NoProfile -File ./install.ps1
export PATH="$HOME/.di/bin:$PATH"
```

安装器将私有运行时放入 `~/.di/ts-cli`，并在 `~/.di/bin` 创建 `di` 启动器。Windows 默认把该目录加入用户 PATH；用 `-SkipPathUpdate` 可跳过。POSIX 系统会设置启动器执行权限并打印 PATH 指令。

升级先验证新运行时，失败时保留原版本；成功升级后，上一版保存在 `~/.di/ts-cli.previous`。
安装范围与失败恢复行为见 [`docs/di-home.md`](docs/di-home.md)。

只构建而不安装：

```sh
npm ci
npm run build
node packages/coding-agent/dist/cli/main.js --info
```

## 使用

```text
di --info
di --help
di --list-models
di --mode json "Summarize this repository"
di --print "Explain this function"
```

默认交互模式可使用 TypeScript TUI；`--mode rpc` 提供 TUI 后端协议。模式、退出码和会话恢复见 [`docs/cli.md`](docs/cli.md)。

## 配置与认证

配置按默认值、`~/.di/config.json`、`<workspace>/.di/config.json` 加载，环境变量优先级最高。DeepSeek 可通过 `DEEPSEEK_API_KEY` 或用户配置提供密钥。ChatGPT OAuth 命令：

```text
di auth chatgpt login
di auth chatgpt status
di auth chatgpt models
di --provider chatgpt --model <model-id> "检查项目"
```

凭据更新使用跨进程原生锁。详见 [`docs/modules/chatgpt.md`](docs/modules/chatgpt.md) 和 [`docs/di-home.md`](docs/di-home.md)。

## 会话与开发

会话默认写入 `~/.di/sessions/`；`DI_HOME` 可更换数据根目录。验证状态见 [`docs/typescript-validation.md`](docs/typescript-validation.md)。

```sh
npm run build
npm run typecheck
npm test
npm run test:compat
```

项目文档从 [`docs/README.md`](docs/README.md) 开始。
