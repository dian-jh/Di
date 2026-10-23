import { readFileSync } from "node:fs";

/**
 * CLI command name and help text. Read the version from package.json so the
 * displayed version matches the installed package metadata.
 */

/** Global command name (also the product artifact name). */
export const CLI_NAME = "di";

/** Version read from package.json at load; falls back to "0.0.0" if unreadable. */
export const CLI_VERSION: string = readPackageVersion();

/** Full usage text for --help. */
export const HELP_TEXT = `di —— 简洁的 ReAct 编码助手（harness）

用法: di [选项] [提示词...]

headless 单发（给一个提示词即跑一个回合后退出）：
  di "读一下 README"               文本输出（默认）
  di --mode json "分析这个函数"      JSON 输出（脚本友好，单文档）
  echo "总结" | di                 无位置参数时从 stdin 读提示词

交互模式：
  di                               进入 REPL（斜杠命令: /help /model /skills /clear /exit）

ChatGPT（官方 OAuth，无需 API Key）：
  di auth chatgpt login             Continue with ChatGPT（复用已有注册）
  di auth chatgpt login --new       注册另一账户或 workspace
  di auth chatgpt login --consent   重新申请 ChatGPT plan 授权
  di auth chatgpt status            查看登录状态
  di auth chatgpt models            获取当前账户可用模型
  di auth chatgpt logout             撤销并退出
  di --provider chatgpt --model <slug> "你好"
  /model                            查看当前模型和目录
  /model chatgpt/<slug>              会话内跨 provider 切换
  /model --refresh                   刷新已配置 provider 的模型目录
  /thinking high                     会话内切换推理强度（/thinking 查看当前及支持档位）
  /thinking default                  恢复模型默认强度
  /usage                             查看 ChatGPT 官方订阅额度入口

选项：
  -m, --model <名>      指定模型（覆盖配置 Model:DefaultModel）
  --provider <id>       指定 provider（覆盖配置 Model:Provider）
  --mode <模式>         interactive / print / json / rpc
  --print               强制文本单发
  --thinking <级别>      推理强度（透传）
  --list-models [pat]   列出可用模型（可按 id/provider 过滤）
  --stats <文件>         聚合一个会话 JSONL 的用量 / 缓存命中率 / 成本
  --skill-eval <文件>    用带标签用例集评估 skill 匹配器（精确率 / 召回率）
  --no-session          headless 不写会话日志（默认写入 ~/.di/sessions/）
  --resume <file>       恢复 checkpoint 会话并进入交互模式
  --no-ansi             禁用 ANSI 控制序列（脚本友好）
  -h, --help            显示本帮助
  --version             显示版本
  --info                打印环境 / 构建 / 生效配置（诊断：验证安装的二进制是否为最新）

配置: ~/.di/config.json 与 <workspace>/.di/config.json（JSON，覆盖 appsettings 默认值）。
`;

/** Convenience object grouping the three metadata pieces (`CliInfo` static class). */
export const CliInfo = {
  name: CLI_NAME,
  version: CLI_VERSION,
  helpText: HELP_TEXT,
};

function readPackageVersion(): string {
  try {
    const url = new URL("../../package.json", import.meta.url);
    const json = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
    return typeof json.version === "string" && json.version.trim().length > 0 ? json.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
