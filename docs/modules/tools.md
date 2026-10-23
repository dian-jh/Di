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
