/**
 * NDJSON 编解码：行帧（处理跨 chunk 拆包）、逐行 parse + 校验、FIFO 消息队列、编码。
 *
 * 本模块不做任何 I/O，可独立单元测试。
 *
 * 帧格式（docs/tui-rpc.md §1）：stdin/stdout 均为 UTF-8 文本流，每行一个 JSON 对象，
 * 以 `\n` 结尾。为兼容 Windows 工具链，解析时容忍行尾 `\r\n`。
 */

import type { AgentEvent, AgentResult, CoreMessage, ModelInfo, SkillInfo, TokenUsage, ToolCall } from "./protocol.ts";

/** 协议解析 / 校验失败。`line` 为原始行（调试用，可能很长）。 */
export class ProtocolError extends Error {
  readonly line: string;

  constructor(message: string, line: string) {
    super(message);
    this.name = "ProtocolError";
    this.line = line;
  }
}

/**
 * 行缓冲：把连续的 raw chunk 切成完整行。
 * 跨 chunk 拆包的半行保留在内部缓冲，直到下一个 `\n` 到来。
 */
export class LineBuffer {
  private buffer = "";

  /** 追加一个 chunk，返回其中所有完整行（不含行尾 `\n`）。 */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      lines.push(this.buffer.slice(0, idx));
      this.buffer = this.buffer.slice(idx + 1);
    }
    return lines;
  }

  /** 返回尚未以 `\n` 终结的残余文本（不清空）。 */
  get pending(): string {
    return this.buffer;
  }

  /** 取出并清空残余文本（流结束时处理最后一段无换行数据）。 */
  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }

  get isEmpty(): boolean {
    return this.buffer.length === 0;
  }
}

/** FIFO 消息队列。 */
export class MessageQueue<T> {
  private items: T[] = [];

  push(item: T): void {
    this.items.push(item);
  }

  /** 取出队首，空队列返回 undefined。 */
  shift(): T | undefined {
    return this.items.shift();
  }

  peek(): T | undefined {
    return this.items[0];
  }

  /** 一次性取空全部。 */
  drain(): T[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }
}

/**
 * 把协议对象编码为一行 NDJSON（`JSON.stringify` + `\n`）。
 * 编码失败（不可序列化的值）时抛出 TypeError。
 */
export function encodeMessage(message: unknown): string {
  return JSON.stringify(message) + "\n";
}

/**
 * 解析并校验一行协议消息。
 * 语法 / 结构不合法时抛出 {@link ProtocolError}，不会返回部分结果。
 * 对未知字段（向后兼容）宽容，对缺失 / 类型错误的关键字段严格。
 */
export function parseMessage(line: string): CoreMessage {
  const trimmed = line.replace(/\r$/, "");
  if (trimmed.trim() === "") {
    throw new ProtocolError("空行不是合法的协议消息", line);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    throw new ProtocolError(`JSON 语法错误: ${(err as Error).message}`, line);
  }
  if (!isObject(raw)) {
    throw new ProtocolError("协议消息必须是 JSON 对象", line);
  }
  return validateCoreMessage(raw as Record<string, unknown>, line);
}

/* ---------------------------------------------------------------------------
 * 校验器（内部使用；对未知 kind/type 抛错，防止静默吞掉结构性错误）
 * ------------------------------------------------------------------------- */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function expectString(value: unknown, field: string, line: string): string {
  if (typeof value !== "string") {
    throw new ProtocolError(`字段 ${field} 应为 string，实际为 ${describe(value)}`, line);
  }
  return value;
}

function expectInt(value: unknown, field: string, line: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ProtocolError(`字段 ${field} 应为整数，实际为 ${describe(value)}`, line);
  }
  return value;
}

function expectBool(value: unknown, field: string, line: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProtocolError(`字段 ${field} 应为 boolean，实际为 ${describe(value)}`, line);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateTokenUsage(value: unknown, line: string): TokenUsage {
  if (!isObject(value)) {
    throw new ProtocolError("usage 应为对象", line);
  }
  const u = value as Record<string, unknown>;
  const usage: TokenUsage = {
    input_tokens: expectInt(u["input_tokens"], "usage.input_tokens", line),
    output_tokens: expectInt(u["output_tokens"], "usage.output_tokens", line),
  };
  const optional: Partial<TokenUsage> = {};
  for (const key of ["total_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"] as const) {
    const v = u[key];
    if (v !== undefined) {
      if (typeof v !== "number") {
        throw new ProtocolError(`字段 usage.${key} 应为 number，实际为 ${describe(v)}`, line);
      }
      optional[key] = v;
    }
  }
  return { ...usage, ...optional };
}

function validateToolCall(value: unknown, line: string): ToolCall {
  if (!isObject(value)) {
    throw new ProtocolError("call 应为对象", line);
  }
  const c = value as Record<string, unknown>;
  return {
    id: expectString(c["id"], "call.id", line),
    name: expectString(c["name"], "call.name", line),
    arguments: expectString(c["arguments"], "call.arguments", line),
  };
}

function validateSkillInfos(value: unknown, line: string): SkillInfo[] {
  if (!Array.isArray(value)) {
    throw new ProtocolError("ready.skills 应为数组", line);
  }
  return value.map((item, i) => {
    if (!isObject(item)) {
      throw new ProtocolError(`ready.skills[${i}] 应为对象`, line);
    }
    return {
      name: expectString(item["name"], `ready.skills[${i}].name`, line),
      description: expectString(item["description"], `ready.skills[${i}].description`, line),
    };
  });
}

function validateModelInfos(value: unknown, line: string): ModelInfo[] {
  if (!Array.isArray(value)) {
    throw new ProtocolError("ready.models 应为数组", line);
  }
  return value.map((item, i) => {
    if (!isObject(item)) {
      throw new ProtocolError(`ready.models[${i}] 应为对象`, line);
    }
    return {
      id: expectString(item["id"], `ready.models[${i}].id`, line),
      name: expectString(item["name"], `ready.models[${i}].name`, line),
    };
  });
}

function validateFailure(value: unknown, line: string): { code: string; message: string } {
  if (!isObject(value)) {
    throw new ProtocolError("failure 应为对象", line);
  }
  const f = value as Record<string, unknown>;
  return {
    code: expectString(f["code"], "failure.code", line),
    message: expectString(f["message"], "failure.message", line),
  };
}

/** 校验 event 载荷（不含 kind 本身）。 */
function validateEventPayload(kind: string, payload: Record<string, unknown>, line: string): AgentEvent {
  switch (kind) {
    case "text_delta":
      return { kind, delta: expectString(payload["delta"], "event.delta", line) };
    case "reasoning_delta":
      return { kind, delta: expectString(payload["delta"], "event.delta", line) };
    case "tool_call_delta":
      return {
        kind,
        id: expectString(payload["id"], "event.id", line),
        name: expectString(payload["name"], "event.name", line),
        arguments: expectString(payload["arguments"], "event.arguments", line),
      };
    case "tool_started":
      return { kind, call: validateToolCall(payload["call"], line) };
    case "tool_completed":
      return {
        kind,
        call: validateToolCall(payload["call"], line),
        observation: expectString(payload["observation"], "event.observation", line),
        is_error: expectBool(payload["is_error"], "event.is_error", line),
      };
    case "turn_completed": {
      const usage = validateTokenUsage(payload["usage"], line);
      const cost = payload["cost"];
      if (cost !== undefined && typeof cost !== "number") {
        throw new ProtocolError(`字段 event.cost 应为 number，实际为 ${describe(cost)}`, line);
      }
      return {
        kind,
        iteration: expectInt(payload["iteration"], "event.iteration", line),
        usage,
        ...(cost === undefined ? {} : { cost }),
        finish_reason: expectString(payload["finish_reason"], "event.finish_reason", line),
      };
    }
    case "run_failed": {
      const f = payload["failure"];
      if (!isObject(f)) {
        throw new ProtocolError("event.failure 应为对象", line);
      }
      const failure: Record<string, unknown> = { ...f };
      for (const key of ["status", "provider_retry_after"] as const) {
        const v = failure[key];
        if (v !== undefined && typeof v !== "number") {
          throw new ProtocolError(`字段 failure.${key} 应为 number，实际为 ${describe(v)}`, line);
        }
      }
      return {
        kind,
        failure: {
          code: expectString(failure["code"], "failure.code", line),
          message: expectString(failure["message"], "failure.message", line),
          ...(failure["status"] === undefined ? {} : { status: failure["status"] as number }),
          ...(failure["provider_retry_after"] === undefined
            ? {}
            : { provider_retry_after: failure["provider_retry_after"] as number }),
        },
      };
    }
    default:
      throw new ProtocolError(`未知的事件 kind: ${JSON.stringify(kind)}`, line);
  }
}

const STOP_REASONS = new Set(["answer", "final_output_tool", "max_iterations", "error", "cancelled"]);

function validateAgentResult(value: unknown, line: string): AgentResult {
  if (!isObject(value)) {
    throw new ProtocolError("result 应为对象", line);
  }
  const r = value as Record<string, unknown>;
  const stopReason = expectString(r["stop_reason"], "result.stop_reason", line);
  if (!STOP_REASONS.has(stopReason)) {
    throw new ProtocolError(`result.stop_reason 非法: ${JSON.stringify(stopReason)}`, line);
  }
  const cost = r["cost"];
  if (cost !== undefined && typeof cost !== "number") {
    throw new ProtocolError(`字段 result.cost 应为 number，实际为 ${describe(cost)}`, line);
  }
  const failure = r["failure"];
  if (failure !== undefined && !isObject(failure)) {
    throw new ProtocolError("result.failure 应为对象", line);
  }
  return {
    answer: expectString(r["answer"], "result.answer", line),
    stop_reason: stopReason as AgentResult["stop_reason"],
    iterations: expectInt(r["iterations"], "result.iterations", line),
    usage: validateTokenUsage(r["usage"], line),
    ...(cost === undefined ? {} : { cost: cost as number }),
    ...(failure === undefined
      ? {}
      : { failure: { code: expectString(failure["code"], "result.failure.code", line), message: expectString(failure["message"], "result.failure.message", line) } }),
  };
}

function validateCoreMessage(m: Record<string, unknown>, line: string): CoreMessage {
  switch (m["type"]) {
    case "ready": {
      // 新旧字段均可选：容忍旧后端（只发 version）。
      return {
        type: "ready",
        version: expectString(m["version"], "ready.version", line),
        ...(m["model"] === undefined ? {} : { model: expectString(m["model"], "ready.model", line) }),
        ...(m["effort"] === undefined
          ? {}
          : { effort: m["effort"] === null ? null : expectString(m["effort"], "ready.effort", line) }),
        ...(m["skills"] === undefined ? {} : { skills: validateSkillInfos(m["skills"], line) }),
        ...(m["models"] === undefined ? {} : { models: validateModelInfos(m["models"], line) }),
      };
    }
    case "event": {
      const event = m["event"];
      if (!isObject(event)) {
        throw new ProtocolError("event 字段应为对象", line);
      }
      const kind = expectString((event as Record<string, unknown>)["kind"], "event.kind", line);
      return {
        type: "event",
        seq: expectInt(m["seq"], "event.seq", line),
        event: validateEventPayload(kind, event as Record<string, unknown>, line),
      };
    }
    case "result":
      return {
        type: "result",
        seq: expectInt(m["seq"], "result.seq", line),
        result: validateAgentResult(m["result"], line),
      };
    case "error":
      return {
        type: "error",
        code: expectString(m["code"], "error.code", line),
        message: expectString(m["message"], "error.message", line),
      };
    case "command_listed": {
      const raw = m["commands"];
      if (!Array.isArray(raw)) {
        throw new ProtocolError("command_listed.commands 应为数组", line);
      }
      const commands = raw.map((c, i) => {
        if (!isObject(c)) {
          throw new ProtocolError(`commands[${i}] 应为对象`, line);
        }
        const name = expectString(c["name"], `commands[${i}].name`, line);
        const description = expectString(c["description"], `commands[${i}].description`, line);
        const hint = c["argument_hint"];
        if (hint !== undefined && typeof hint !== "string") {
          throw new ProtocolError(`commands[${i}].argument_hint 应为 string`, line);
        }
        return {
          name,
          description,
          ...(hint === undefined ? {} : { argument_hint: hint as string }),
        };
      });
      return { type: "command_listed", commands };
    }
    case "command_ran": {
      const rawLines = m["lines"];
      if (!Array.isArray(rawLines) || rawLines.some((l) => typeof l !== "string")) {
        throw new ProtocolError("command_ran.lines 应为 string 数组", line);
      }
      return {
        type: "command_ran",
        name: expectString(m["name"], "command_ran.name", line),
        lines: rawLines as string[],
        exit: expectBool(m["exit"], "command_ran.exit", line),
        ...(m["model"] === undefined ? {} : { model: expectString(m["model"], "command_ran.model", line) }),
        ...(m["effort"] === undefined
          ? {}
          : { effort: m["effort"] === null ? null : expectString(m["effort"], "command_ran.effort", line) }),
      };
    }
    case "command_error":
      return {
        type: "command_error",
        code: expectString(m["code"], "command_error.code", line),
        message: expectString(m["message"], "command_error.message", line),
        ...(m["turn_message"] === undefined
          ? {}
          : { turn_message: expectString(m["turn_message"], "command_error.turn_message", line) }),
      };
    default:
      throw new ProtocolError(`未知的消息 type: ${JSON.stringify(m["type"])}`, line);
  }
}

