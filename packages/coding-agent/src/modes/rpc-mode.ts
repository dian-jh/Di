import type { AgentResult } from "@di/agent";
import { LexicalSkillMatcher } from "../core/skills/skill-matcher.ts";
import { computeSkillActivation } from "../core/skills/skill-activation.ts";
import type { Skill } from "../core/skills/skill.ts";
import { ModelSelectionError } from "../core/model-selection.ts";
import type { CommandContext } from "../core/commands/command-context.ts";
import { StringCommandOutput } from "../core/commands/command-context.ts";
import { CLI_VERSION } from "../cli/cli-info.ts";
import type { CliArgs } from "../cli/args.ts";
import type { CliHost } from "../cli/cli-host.ts";
import type { TextReader, TextWriter } from "../cli/io.ts";
import { EventConsumer } from "../core/events/event-bus.ts";
import { appendFailure, appendTurn, errorMessage } from "./common.ts";
import {
  SeqCounter,
  eventPayload,
  isAbortError,
  resultPayload,
  zeroUsage,
} from "./wire.ts";

/*
 * RPC mode (--mode rpc): an NDJSON over stdin/stdout session driver
 * (docs/tui-rpc.md is the wire-protocol authority; the TS TUI consumer
 * `tui/src/rpc/codec.ts` is the reference for the exact shapes). Requests are
 * processed serially; a `prompt` runs its turn in the background so `interrupt` /
 * `shutdown` can arrive mid-turn (stdin is a pipe, no console Ctrl+C). Failures
 * are messages, not crashes: run_failed / result.stop_reason "error"; a parse
 * failure emits an `error` line and continues; stdin EOF finishes the current
 * turn then exits 0. Serialization PrintMode / SessionLog: snake_case,
 * null keys omitted, native UTF-8 (JSON.stringify).
 *
 * busy envelope: a turn in progress rejects `set_model` with `error: busy`
 * and `command` model/thinking with `command_error: busy` (the pre-check);
 * a `ModelSelectionError.code === "busy"` from a command handler maps to the same
 * `command_error: busy` envelope.
 */

interface RpcRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export async function runRpcMode(
  host: CliHost,
  args: CliArgs,
  stdin: TextReader,
  stdout: TextWriter,
  stderr: TextWriter,
  signal?: AbortSignal,
): Promise<number> {
  if (host == null) throw new TypeError("runRpcMode: host is required");

  for (const error of await host.models.refresh(signal)) stderr.writeLine(error);

  // 组合根已构建、可服务请求：先握手（仅一次）。携带当前模型/强度/skills/模型目录快照。
  emit(stdout, {
    type: "ready",
    version: CLI_VERSION,
    model: host.runner.currentModel,
    ...(host.reasoningEffort !== undefined && host.reasoningEffort !== null ? { effort: host.reasoningEffort } : {}),
    skills: host.skills.map((s) => ({ name: s.name, description: s.description })),
    models: host.models.list().map((m) => ({ id: `${m.provider}/${m.id}`, name: m.name })),
  });

  // 会话开始写首行 session_meta（尽力而为；--no-session 时跳过）。
  if (!args.noSession) {
    try {
      host.sessionStore?.startSession();
    } catch (error) {
      stderr.writeLine(`⚠ 会话日志初始化失败: ${errorMessage(error)}`);
    }
  }

  // 命令系统：注册表来自宿主；固定 skill 集在会话内跨命令保持（/skill 激活、/skills 标记）。
  const pinned: Skill[] = [];
  let turnTask: Promise<void> | null = null;
  let turnCts: AbortController | null = null;

  try {
    while (true) {
      const line = await stdin.readLine();
      if (line === null) break; // stdin EOF：结束当前回合后退出 0

      let request: RpcRequest;
      try {
        request = parseRequest(line);
      } catch (error) {
        emit(stdout, { type: "error", code: "parse_error", message: errorMessage(error) });
        continue;
      }

      switch (request.method) {
        case "prompt": {
          // 串行：先完成上一回合（协议要求 TUI 等 result 后再发下一条，此处只是防御）。
          await finishTurn(turnTask);
          const message = paramsString(request.params, "message");
          if (message === undefined) {
            emit(stdout, { type: "error", code: "invalid_request", message: "prompt 缺少 message 字符串参数" });
            break;
          }
          // 回合级取消源：interrupt 请求只取消它，不取消整个进程生命周期。
          turnCts = new AbortController();
          const turnSignal = signal !== undefined ? AbortSignal.any([signal, turnCts.signal]) : turnCts.signal;
          host.runner.setActiveSkills(computeSkillActivation(message, host.skills, pinned, new LexicalSkillMatcher()).active);
          const messageForTurn = message;
          turnTask = runTurnTask(host, args, messageForTurn, stdout, stderr, turnSignal).finally(() => {
            turnTask = null;
            turnCts = null;
          });
          break;
        }

        case "interrupt":
          turnCts?.abort(); // 取消当前回合 → 对应 result.stop_reason:"cancelled"
          break;

        case "set_model": {
          if (turnTask !== null) {
            emit(stdout, { type: "error", code: "busy", message: "请等待当前回合结束后切换模型。" });
            break;
          }
          const model = paramsString(request.params, "model");
          if (model === undefined) {
            emit(stdout, { type: "error", code: "invalid_request", message: "set_model 缺少 model 字符串参数" });
            break;
          }
          try {
            await host.models.select(model, signal);
          } catch (error) {
            if (error instanceof ModelSelectionError && error.code === "busy") {
              emit(stdout, { type: "error", code: "busy", message: error.message });
            } else {
              emit(stdout, { type: "error", code: "invalid_model", message: errorMessage(error) });
            }
          }
          break;
        }

        case "set_skills": {
          const names = paramsStringArray(request.params, "names");
          if (names === undefined) {
            emit(stdout, { type: "error", code: "invalid_request", message: "set_skills 缺少 names 字符串数组参数" });
            break;
          }
          // 只接受宿主已发现的 skill（未知名静默忽略，避免把任意字符串塞给 runner）。
          const wanted = new Set(names);
          pinned.length = 0;
          for (const s of host.skills) if (wanted.has(s.name)) pinned.push(s);
          host.runner.setActiveSkills([...pinned]);
          break;
        }

        case "clear_history":
          host.runner.resetHistory();
          break;

        case "command": {
          const name = paramsString(request.params, "name");
          if (turnTask !== null && (name === "model" || name === "thinking")) {
            emit(stdout, { type: "command_error", code: "busy", message: "请等待当前回合结束后切换模型。" });
            break;
          }
          await handleCommand(host, pinned, request, stdout, signal);
          break;
        }

        case "ping":
          break; // 心跳，无应答

        case "shutdown":
          await finishTurn(turnTask);
          return 0;

        default:
          emit(stdout, { type: "error", code: "unknown_method", message: `未知方法: ${request.method}` });
          break;
      }
    }

    // stdin EOF：结束当前回合后退出 0（回合是后台任务，result 已由其自行发出）。
    await finishTurn(turnTask);
    return 0;
  } finally {
    turnCts?.abort();
  }
}

/** Wait for the background turn task; its result/error was already emitted by the task itself. */
async function finishTurn(turnTask: Promise<void> | null): Promise<void> {
  if (turnTask === null) return;
  try {
    await turnTask;
  } catch {
    // 回合内部已尽力自处理，这里只确保不崩。
  }
}

/**
 * Run one turn: forward events to stdout in real time, emit the single `result`,
 * and persist the session log. Every in-turn failure is digested here — it never
 * escapes to the main loop.
 */
async function runTurnTask(
  host: CliHost,
  args: CliArgs,
  message: string,
  stdout: TextWriter,
  stderr: TextWriter,
  signal: AbortSignal,
): Promise<void> {
  const consumer = host.bus.subscribe();
  const seq = new SeqCounter();
  const forwardTask = forwardEvents(consumer, stdout, seq);
  const startedAt = Date.now();

  let result: AgentResult;
  try {
    result = await host.runner.runTurn(message, signal);
  } catch (error) {
    host.bus.release(consumer);
    await forwardTask;
    drain(consumer, stdout, seq);
    if (isAbortError(error)) {
      // 回合被 interrupt 取消：合成 cancelled result（AgentStopReason 无此值，宿主层映射）。
      emit(stdout, {
        type: "result",
        seq: seq.next(),
        result: { answer: "", stop_reason: "cancelled", iterations: 0, usage: zeroUsage() },
      });
    } else {
      // 回合失败是消息不是崩溃：result.stop_reason:"error" 并带 failure。
      emit(stdout, {
        type: "result",
        seq: seq.next(),
        result: {
          answer: "",
          stop_reason: "error",
          iterations: 0,
          usage: zeroUsage(),
          failure: { code: "model_error", message: errorMessage(error) },
        },
      });
      appendFailure(host, args, message, errorMessage(error), startedAt, stderr);
    }
    return;
  }

  host.bus.release(consumer);
  await forwardTask;
  drain(consumer, stdout, seq);
  appendTurn(host, args, result, startedAt, stderr);
  emit(stdout, { type: "result", seq: seq.next(), result: resultPayload(result) });
}

/** Real-time event forwarding (each line flushed by the writer; a forward failure never breaks the turn). */
async function forwardEvents(consumer: EventConsumer, stdout: TextWriter, seq: SeqCounter): Promise<void> {
  for await (const event of consumer) {
    const payload = eventPayload(event);
    if (payload === undefined) continue; // interrupted omitted: the TUI codec does not accept that kind
    try {
      emit(stdout, { type: "event", seq: seq.next(), event: payload });
    } catch {
      // 转发失败不打断回合。
    }
  }
}

/** Best-effort drain of events the forwarder did not consume. */
function drain(consumer: EventConsumer, stdout: TextWriter, seq: SeqCounter): void {
  let event = consumer.tryRead();
  while (event !== null) {
    const payload = eventPayload(event);
    if (payload !== undefined) emit(stdout, { type: "event", seq: seq.next(), event: payload });
    event = consumer.tryRead();
  }
}

/**
 * `command` request (see `docs/tui-rpc.md`): `list` lists the registry; `run` runs a
 * synchronous command. A turn-type command (result carries a TurnMessage, e.g.
 * /skill with args, user commands) → `command_error: turn_not_supported` with the
 * turn message — RPC has no turn executor, the TUI runs it through its own prompt
 * mechanism. A busy `ModelSelectionError` maps to `command_error: busy`.
 */
async function handleCommand(
  host: CliHost,
  pinned: Skill[],
  request: RpcRequest,
  stdout: TextWriter,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const params = request.params;
    if (params["list"] === true) {
      const entries = host.commands
        .list()
        .map((c) => ({
          name: c.name,
          description: c.description,
          ...(c.argumentHint !== undefined ? { argument_hint: c.argumentHint } : {}),
        }));
      emit(stdout, { type: "command_listed", commands: entries });
      return;
    }

    const name = params["name"];
    if (typeof name !== "string") throw new Error("command run 需要 name 字符串参数");
    const args = typeof params["args"] === "string" ? params["args"] : "";

    const cmd = host.commands.tryGet(name);
    if (cmd === undefined) {
      emit(stdout, { type: "command_error", code: "unknown_command", message: `未知命令: /${name}` });
      return;
    }

    // 命令输出写进内存缓冲，随应答返回（stdout 是协议流，不允许命令直接写）。
    const buffer = new StringCommandOutput();
    const context: CommandContext = {
      registry: host.commands,
      host: host.runner,
      skills: host.skills,
      output: buffer,
      pinned,
      useAnsi: false,
      models: host.models,
      ...(signal !== undefined ? { signal } : {}),
    };

    let commandResult;
    try {
      commandResult = await cmd.handler(args, context);
    } catch (error) {
      if (error instanceof ModelSelectionError && error.code === "busy") {
        emit(stdout, { type: "command_error", code: "busy", message: error.message });
        return;
      }
      throw error;
    }

    if (commandResult.turnMessage !== undefined && commandResult.turnMessage.length > 0) {
      // 回合型命令：错误载荷附带 turn_message（指令+参数全文），TUI 据此改用自身 prompt 机制跑回合。
      emit(stdout, {
        type: "command_error",
        code: "turn_not_supported",
        message: `命令 /${name} 是回合型命令，TUI 应改用 prompt 执行（turn_message 已附指令全文）`,
        turn_message: commandResult.turnMessage,
      });
      return;
    }

    // 应答携带执行后的模型/强度快照（/model 切换后 TUI 据此更新状态栏，不依赖解析中文提示）。
    emit(stdout, {
      type: "command_ran",
      name,
      lines: bufferLines(buffer),
      exit: commandResult.exit,
      model: host.runner.currentModel,
      ...(host.reasoningEffort !== undefined && host.reasoningEffort !== null ? { effort: host.reasoningEffort } : {}),
      ...(name === "model"
        ? { models: host.models.list().map((m) => ({ id: `${m.provider}/${m.id}`, name: m.name })) }
        : {}),
    });
  } catch (error) {
    emit(stdout, { type: "command_error", code: "invalid_request", message: errorMessage(error) });
  }
}

/** Command output buffer → non-empty line array (no \r; RPC replies carry no ANSI). */
function bufferLines(buffer: StringCommandOutput): string[] {
  return buffer
    .toString()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.replace(/\r$/, ""));
}

/** Parse one NDJSON request line; syntax / shape errors throw (the caller emits `parse_error`). */
function parseRequest(line: string): RpcRequest {
  let root: unknown;
  try {
    root = JSON.parse(line);
  } catch (error) {
    throw new Error(`JSON 语法错误: ${errorMessage(error)}`);
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new Error("请求必须是 JSON 对象");
  }
  const obj = root as Record<string, unknown>;
  const method = obj["method"];
  if (typeof method !== "string") throw new Error("请求缺少 method 字符串字段");
  const params = obj["params"];
  const paramsObject =
    typeof params === "object" && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
  return { method, params: paramsObject };
}

function paramsString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function paramsStringArray(params: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = params[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((v) => typeof v === "string") as string[];
}

/** One result / event line; stdout writes are synchronous, so line order == publish order. */
function emit(stdout: TextWriter, message: unknown): void {
  stdout.writeLine(JSON.stringify(message));
}
