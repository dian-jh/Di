// 测试用假后端：模拟 `di --mode rpc` 的最小协议行为。
//
// 行为：
//   - 启动即发 `ready`（FAKE_MODE=exit 时直接 exit 1，模拟旧版不支持 rpc）。
//   - 收到 `prompt` 请求 → 发一段事件流（text/tool/iteration）+ 一个 `result`。
//   - 收到 `shutdown` → exit 0。
//   - 其余请求（ping 等）无应答。
//
// 只在测试中使用，不属于产品代码。

import process from "node:process";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_MODE ?? "ok";

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (mode === "exit") {
  process.exit(1);
}

write({
  type: "ready",
  version: "0.0.0-fake",
  model: "deepseek-flash",
  effort: "high",
  skills: [{ name: "backend-tests", description: "跑后端测试" }],
  models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }, { id: "deepseek-v4-pro", name: "DeepSeek Pro" }],
});

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

let seq = 0;

rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.type !== "request") return;

  switch (req.method) {
    case "shutdown":
      process.exit(0);
      break;
    case "prompt": {
      seq += 1;
      const s = seq;
      write({ type: "event", seq: s, event: { kind: "text_delta", delta: "Hello from fake. " } });
      write({ type: "event", seq: s + 1, event: { kind: "tool_call_delta", id: "t1", name: "fake_tool", arguments: '{"x":' } });
      write({ type: "event", seq: s + 2, event: { kind: "tool_call_delta", id: "t1", name: "fake_tool", arguments: '{"x":1}' } });
      write({ type: "event", seq: s + 3, event: { kind: "tool_started", call: { id: "t1", name: "fake_tool", arguments: '{"x":1}' } } });
      write({
        type: "event",
        seq: s + 4,
        event: { kind: "tool_completed", call: { id: "t1", name: "fake_tool", arguments: '{"x":1}' }, observation: "ok", is_error: false },
      });
      write({ type: "event", seq: s + 5, event: { kind: "text_delta", delta: "Done." } });
      write({
        type: "event",
        seq: s + 6,
        event: { kind: "turn_completed", iteration: 1, usage: { input_tokens: 10, output_tokens: 5 }, cost: 0.001, finish_reason: "answer" },
      });
      write({
        type: "result",
        seq: s + 6,
        result: { answer: "Hello from fake. Done.", stop_reason: "answer", iterations: 1, usage: { input_tokens: 10, output_tokens: 5 }, cost: 0.001 },
      });
      seq = s + 6;
      break;
    }
    case "command": {
      const params = req.params ?? {};
      if (params.list === true) {
        write({
          type: "command_listed",
          commands: [
            { name: "model", description: "切换模型", argument_hint: "<模型名>" },
            { name: "exit", description: "退出 Di" },
          ],
        });
      } else if (params.name === "model") {
        write({
          type: "command_ran",
          name: "model",
          lines: [`模型已切换为 ${params.args ?? ""}`],
          exit: false,
          model: params.args ?? "deepseek-flash",
          effort: params.args?.startsWith("chatgpt/") ? null : "high",
          models: [{ id: "chatgpt/account-model", name: "Account model" }],
        });
      } else if (params.name === "skill") {
        // 回合型命令：错误载荷附带 turn_message（TUI 据此改用 prompt 跑回合）。
        const [skillName, ...rest] = (params.args ?? "").split(" ");
        write({
          type: "command_error",
          code: "turn_not_supported",
          message: "回合型命令",
          turn_message: `【Skill：${skillName}】跑后端测试\n\ndotnet test\n\n${rest.join(" ")}`,
        });
      } else if (params.name === "exit") {
        write({ type: "command_ran", name: "exit", lines: [], exit: true });
      } else {
        write({ type: "command_error", code: "unknown_command", message: `未知命令: /${params.name}` });
      }
      break;
    }
    default:
      break;
  }
});
