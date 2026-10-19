/**
 * codec 单元测试：行帧（拆包/多行）、parse+validate、FIFO 队列、编码往返。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeMessage, LineBuffer, MessageQueue, parseMessage, ProtocolError } from "../src/rpc/codec.ts";

describe("LineBuffer（NDJSON 行帧）", () => {
  it("单 chunk 单行", () => {
    const buf = new LineBuffer();
    assert.deepEqual(buf.push('{"type":"ready"}\n'), ['{"type":"ready"}']);
  });

  it("单 chunk 多行", () => {
    const buf = new LineBuffer();
    assert.deepEqual(buf.push('{"type":"ready"}\n{"type":"ping"}\n'), ['{"type":"ready"}', '{"type":"ping"}']);
  });

  it("一行跨多个 chunk 拆包", () => {
    const buf = new LineBuffer();
    assert.deepEqual(buf.push('{"type":"rea'), []);
    assert.deepEqual(buf.push('dy","version"'), []);
    assert.deepEqual(buf.push(':"1.0"}\nnext\n'), ['{"type":"ready","version":"1.0"}', "next"]);
  });

  it("结尾无换行的半行暂存", () => {
    const buf = new LineBuffer();
    assert.deepEqual(buf.push('{"type":"ready"'), []);
    assert.equal(buf.pending, '{"type":"ready"');
    assert.deepEqual(buf.flush(), '{"type":"ready"');
  });

  it("一个字节一个字节喂入也能拼出完整行", () => {
    const buf = new LineBuffer();
    const chunks = [...'{"a":1}\n{"b":2}\n'];
    const all: string[] = [];
    for (const c of chunks) all.push(...buf.push(c));
    assert.deepEqual(all, ['{"a":1}', '{"b":2}']);
  });
});

describe("encodeMessage", () => {
  it("对象 → 一行 NDJSON（带 \\n）", () => {
    assert.equal(encodeMessage({ type: "ready", version: "1.0" }), '{"type":"ready","version":"1.0"}\n');
  });
});

describe("parseMessage（parse + validate）", () => {
  it("解析合法 ready / event / result / error", () => {
    assert.deepEqual(parseMessage('{"type":"ready","version":"0.1.0"}'), { type: "ready", version: "0.1.0" });

    const event = parseMessage('{"type":"event","seq":3,"event":{"kind":"tool_completed","call":{"id":"t1","name":"x","arguments":"{}"},"observation":"ok","is_error":false}}');
    assert.equal(event.type, "event");
    if (event.type !== "event") throw new Error("unreachable");
    assert.equal(event.event.kind, "tool_completed");

    const result = parseMessage('{"type":"result","seq":9,"result":{"answer":"hi","stop_reason":"answer","iterations":1,"usage":{"input_tokens":1,"output_tokens":2}}}');
    assert.equal(result.type, "result");
    if (result.type !== "result") throw new Error("unreachable");
    assert.equal(result.result.answer, "hi");

    assert.deepEqual(parseMessage('{"type":"error","code":"E_AUTH","message":"bad key"}'), {
      type: "error",
      code: "E_AUTH",
      message: "bad key",
    });
  });

  it("解析富化 ready（模型/强度/skills/模型目录）", () => {
    const msg = parseMessage(
      '{"type":"ready","version":"0.1.0","model":"deepseek-flash","effort":"high","skills":[{"name":"backend-tests","description":"跑后端测试"}],"models":[{"id":"m1","name":"M1"}]}',
    );
    assert.equal(msg.type, "ready");
    if (msg.type !== "ready") throw new Error("unreachable");
    assert.equal(msg.version, "0.1.0");
    assert.equal(msg.model, "deepseek-flash");
    assert.equal(msg.effort, "high");
    assert.deepEqual(msg.skills, [{ name: "backend-tests", description: "跑后端测试" }]);
    assert.deepEqual(msg.models, [{ id: "m1", name: "M1" }]);
  });

  it("容忍旧后端 ready 缺省新字段（向后兼容）", () => {
    const msg = parseMessage('{"type":"ready","version":"0.1.0"}');
    assert.equal(msg.type, "ready");
    if (msg.type !== "ready") throw new Error("unreachable");
    assert.equal(msg.model, undefined);
    assert.equal(msg.effort, undefined);
    assert.equal(msg.skills, undefined);
  });

  it("解析 command_ran 携带模型/强度快照", () => {
    const msg = parseMessage(
      '{"type":"command_ran","name":"model","lines":["模型已切换为 deepseek-v4-pro"],"exit":false,"model":"deepseek-v4-pro","effort":"high"}',
    );
    assert.equal(msg.type, "command_ran");
    if (msg.type !== "command_ran") throw new Error("unreachable");
    assert.equal(msg.model, "deepseek-v4-pro");
    assert.equal(msg.effort, "high");
  });

  it("解析 command_error 携带 turn_message（回合型命令回退）", () => {
    const msg = parseMessage(
      '{"type":"command_error","code":"turn_not_supported","message":"回合型命令","turn_message":"【Skill：backend-tests】跑后端测试\\n\\ndotnet test\\n\\n补测试"}',
    );
    assert.equal(msg.type, "command_error");
    if (msg.type !== "command_error") throw new Error("unreachable");
    assert.equal(msg.code, "turn_not_supported");
    assert.equal(msg.turn_message, "【Skill：backend-tests】跑后端测试\n\ndotnet test\n\n补测试");
  });

  it("容忍 \\r\\n 行尾", () => {
    const msg = parseMessage('{"type":"ready","version":"1.0"}\r');
    assert.deepEqual(msg, { type: "ready", version: "1.0" });
  });

  it("容忍可省略的可选字段（null 键省略）", () => {
    const msg = parseMessage('{"type":"result","seq":1,"result":{"answer":"","stop_reason":"cancelled","iterations":0,"usage":{"input_tokens":0,"output_tokens":0}}}');
    assert.equal(msg.type, "result");
  });

  it("拒绝语法错误的 JSON", () => {
    assert.throws(() => parseMessage('{"type":"ready"'), ProtocolError);
  });

  it("拒绝空行", () => {
    assert.throws(() => parseMessage(""), ProtocolError);
  });

  it("拒绝非对象", () => {
    assert.throws(() => parseMessage('"just a string"'), ProtocolError);
    assert.throws(() => parseMessage("[1,2]"), ProtocolError);
  });

  it("拒绝未知消息 type", () => {
    assert.throws(() => parseMessage('{"type":"nope"}'), /未知的消息 type/);
  });

  it("拒绝缺字段 / 类型错误", () => {
    assert.throws(() => parseMessage('{"type":"ready"}'), /ready\.version/);
    assert.throws(() => parseMessage('{"type":"event","seq":"x","event":{"kind":"text_delta","delta":"a"}}'), /event\.seq/);
    assert.throws(() => parseMessage('{"type":"event","seq":1,"event":{"kind":"text_delta"}}'), /event\.delta/);
    assert.throws(() => parseMessage('{"type":"result","seq":1,"result":{"answer":"x","stop_reason":"bogus","iterations":1,"usage":{}}}'), /stop_reason/);
  });

  it("拒绝未知事件 kind（向后兼容告警场景）", () => {
    assert.throws(() => parseMessage('{"type":"event","seq":1,"event":{"kind":"brand_new","x":1}}'), /未知的事件 kind/);
  });

  it("拒绝 tool_completed 的 is_error 非布尔", () => {
    assert.throws(
      () =>
        parseMessage(
          '{"type":"event","seq":1,"event":{"kind":"tool_completed","call":{"id":"a","name":"b","arguments":"{}"},"observation":"","is_error":"yes"}}',
        ),
      /is_error/,
    );
  });
  it("accepts the context budget pause stop reason", () => {
    const msg = parseMessage('{"type":"result","seq":2,"result":{"answer":"","stop_reason":"context_limit","iterations":0,"usage":{"input_tokens":0,"output_tokens":0}}}');
    assert.equal(msg.type, "result");
    if (msg.type !== "result") throw new Error("unreachable");
    assert.equal(msg.result.stop_reason, "context_limit");
  });
});
describe("MessageQueue（FIFO）", () => {
  it("保留模型命令返回的完整目录，并拒绝无效条目", () => {
    const message = parseMessage(JSON.stringify({ type: "command_ran", name: "model", lines: [], exit: false,
      model: "chatgpt/account-model", models: [{ id: "chatgpt/account-model", name: "Account model" }] }));
    assert.equal(message.type, "command_ran");
    if (message.type === "command_ran") {
      assert.deepEqual(message.models, [{ id: "chatgpt/account-model", name: "Account model" }]);
    }
    assert.throws(() => parseMessage(JSON.stringify({ type: "command_ran", name: "model", lines: [], exit: false,
      models: [{ id: 123, name: "invalid" }] })), /models/);
  });
  it("先进先出", () => {
    const q = new MessageQueue<number>();
    q.push(1);
    q.push(2);
    assert.equal(q.size, 2);
    assert.equal(q.shift(), 1);
    assert.equal(q.shift(), 2);
    assert.equal(q.shift(), undefined);
  });

  it("drain / clear", () => {
    const q = new MessageQueue<number>();
    q.push(1);
    q.push(2);
    assert.deepEqual(q.drain(), [1, 2]);
    assert.equal(q.isEmpty, true);
    q.push(3);
    q.clear();
    assert.equal(q.isEmpty, true);
  });
});
