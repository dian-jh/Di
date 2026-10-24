# 工具

`packages/coding-agent/src/core/tools/types.ts` 定义 `CoreTool`：每个工具提供模型可见的 `ToolSpec`
及接收原始 JSON 参数字符串和可选 `AbortSignal` 的执行函数。`core/tools/index.ts` 的
`createFileTools` 创建文件工具；`createToolExecutor` 按名称分派并把取消信号继续传给工具，未知
工具名返回错误观察。

默认组合根注册的八类工具为 `read_file`、`write_file`、`edit_file`、`glob`、`grep`、平台 shell
（Windows 显示 `cmd`、POSIX 显示 `bash`）、`powershell` 和 `python`。平台 shell 还接受 `bash`
兼容调用名。定义位于 `read.ts`、`write.ts`、`edit.ts`、`glob.ts`、`grep.ts`、`bash.ts`、
`powershell.ts`、`python.ts`。

`shell-session.ts` 管理惰性启动的持久 shell；平台 shell 与 PowerShell 使用独立会话，由
`packages/coding-agent/src/cli/cli-host-compose.ts` 创建并随 host 释放。`process-runner.ts` 负责
一次性进程生命周期；`encoding.ts` 处理子进程文本，`output-buffer.ts` 限制捕获输出。工具不是
OS 沙盒，调用能力取决于 Di 进程身份。

`ShellSession.runCommand_` 将 PowerShell 命令编码为 UTF-8/Base64，再通过点调用
`ScriptBlock.Create` 在当前会话作用域执行；引号或括号不完整时立即返回语法错误，
不会把后续完成标记吞进未结束的输入。每次调用重置 `LASTEXITCODE`，避免上次错误污染
下一条成功命令的退出码；变量、目录和环境仍跨调用保留。
`writeStdin` 和输出队列读取均接收生命周期取消信号，超时或取消也能打断 stdin 背压等待。
回归测试见 `packages/coding-agent/test/tools/powershell-session-regression.test.ts`。

默认宿主在 `packages/coding-agent/src/cli/cli-host-compose.ts` 的 `createCliHost` 中通过
`createPythonTool(undefined, { sandboxDirectory: workspace })` 配置 Python：可执行文件
使用 PATH 中的 `python`，默认工作目录为当前 workspace。
