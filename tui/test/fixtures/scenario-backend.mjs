// 场景化假后端：env SCENARIO 控制行为，供 launcher 注入接缝与客户端协议场景测试使用。
// 只在测试中使用，不属于产品代码。线协议形状见 docs/tui-rpc.md。
//
// SCENARIO 取值：
//   ok               —— 最小行为（ready + prompt 事件流/result + shutdown）
//   chunked          —— 逐字符写入（制造跨 chunk 行拆分）；result 后向 stdout 追加非协议垃圾行
//   dup_result       —— 一个 prompt 发两个 result（模拟有缺陷后端，验证终态恰好一次）
//   stderr_noise     —— ready 前向 stderr 写伪协议 JSON 行、向 stdout 写垃圾行（验证 stdout 协议隔离）
//   exit_mid_turn    —— prompt 时发一个事件后 exit 3（回合中途异常退出清理）
//   exit_after_ready —— 发 ready 后立即 exit 1（连接后异常退出清理）
import process from "node:process";
import { createInterface } from "node:readline";

const scenario = process.env.SCENARIO ?? "ok";

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/** 逐字符写入一行 JSON + \n：制造大量跨 chunk 拆分（流式消费 / 排空场景）。 */
function writeTiny(obj) {
  for (const ch of `${JSON.stringify(obj)}\n`) process.stdout.write(ch);
}

function readyMessage() {
  return {
    type: "ready",
    version: "0.0.0-scenario",
    model: "deepseek-flash",
    effort: "high",
    skills: [],
    models: [],
  };
}

function turnEvents(msg, s) {
  return [
    { type: "event", seq: s, event: { kind: "text_delta", delta: `[${msg}] ` } },
    {
      type: "event",
      seq: s + 1,
      event: { kind: "turn_completed", iteration: 1, usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "answer" },
    },
  ];
}

function resultMessage(msg, s) {
  return {
    type: "result",
    seq: s + 1,
    result: { answer: `result for ${msg}`, stop_reason: "answer", iterations: 1, usage: { input_tokens: 1, output_tokens: 1 } },
  };
}

if (scenario === "stderr_noise") {
  // 协议隔离：stderr 上的 JSON 行绝不参与协议解析；stdout 上的垃圾行触发 onMalformed。
  process.stderr.write(`${JSON.stringify({ type: "ready", version: "faked-on-stderr" })}\n`);
  process.stdout.write(`[boot] initializing config...\n`);
}

if (scenario === "chunked") {
  writeTiny(readyMessage());
} else if (scenario === "exit_after_ready") {
  write(readyMessage());
  process.exit(1);
} else {
  write(readyMessage());
}

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
      const msg = req.params?.message ?? "?";
      seq += 1;
      const s = seq;
      const events = turnEvents(msg, s);
      const result = resultMessage(msg, s);
      if (scenario === "chunked") {
        for (const e of events) writeTiny(e);
        writeTiny(result);
        // result 之后追加一行非协议日志：客户端应触发 onMalformed 且不打断下一回合（排空）。
        process.stdout.write(`[log] trailing non-protocol line after result\n`);
      } else if (scenario === "dup_result") {
        for (const e of events) write(e);
        write(result);
        write({ ...result, result: { ...result.result, answer: "duplicate second result" } });
      } else if (scenario === "exit_mid_turn") {
        write(events[0]);
        process.exit(3);
      } else {
        for (const e of events) write(e);
        write(result);
      }
      seq = s + 1;
      break;
    }
    case "command": {
      const params = req.params ?? {};
      if (params.list === true) {
        write({ type: "command_listed", commands: [{ name: "clear", description: "清屏" }] });
      } else {
        write({ type: "command_ran", name: params.name ?? "", lines: [], exit: false });
      }
      break;
    }
    default:
      break;
  }
});
