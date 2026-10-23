import type { StopReason } from "@di/agent";

/**
 *
 * The fixtures live at the repo root `fixtures/` and are the single shared
 *
 * This validator encodes the schema documented in `fixtures/README.md` (and
 * `fixtures/schema.json`) as typed checks. `validateFixture` returns an empty
 * array when the value satisfies the schema, otherwise a list of errors.
 *
 * No third-party JSON-Schema engine is used (zero new dependencies).
 */

export type JsonRecord = Readonly<Record<string, unknown>>;

/** Minimal JSON shape of the @di/ai ContentBlock union (only text/tool-call are fully checked). */
export type ContentBlockJson =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
    }
  | { readonly type: string };

/** JSON shape of the @di/ai AgentMessage union as serialized in a fixture. */
export type AgentMessageJson =
  | { readonly role: "system"; readonly text: string }
  | { readonly role: "user"; readonly content: readonly ContentBlockJson[] }
  | { readonly role: "assistant"; readonly content: readonly ContentBlockJson[] }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string; readonly isError: boolean };

export interface ToolCallJson {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ToolSpecJson {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonRecord;
  readonly strict?: boolean;
}

export interface TokenUsageJson {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export interface UsageCostJson {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface LlmFailureJson {
  readonly message: string;
  readonly code: string;
  readonly status?: number;
  readonly providerRetryAfterMs?: number;
  readonly requestId?: string;
}

/** One scripted model call: either a completed response or a failure. */
export interface ModelStepJson {
  readonly text: string | null;
  readonly toolCalls: readonly ToolCallJson[];
  readonly finishReason: "stop" | "tool-calls" | "max-tokens";
  readonly failure: LlmFailureJson | null;
  readonly usage: TokenUsageJson;
  readonly cost: UsageCostJson | null;
  readonly model: string;
}

export interface ModelScriptJson {
  readonly responses: readonly ModelStepJson[];
  readonly fallback?: ModelStepJson;
}

export interface InterruptScriptJson {
  /** Request soft stop right after the n-th model call returns (before tool execution). */
  readonly softStopAfterTurn?: number;
  /** Abort the run signal right after the first tool executes. */
  readonly cancelAfterTool?: boolean;
}

export interface LoopFixtureInput {
  readonly sessionId: string;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly history: readonly AgentMessageJson[];
  readonly systemContext: string | null;
  readonly tools: readonly ToolSpecJson[];
  readonly contextTokenBudget: number | null;
  readonly maxIterations: number;
  readonly maxTokens: number | null;
  readonly reasoningEffort: string | null;
  readonly finalOutputTool: string | null;
  readonly interrupt?: InterruptScriptJson;
  readonly model: ModelScriptJson;
}

export interface ExpectedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
  readonly observation: string;
  readonly isError: boolean;
}

export interface LoopFixtureExpected {
  readonly stopReason: StopReason | null;
  readonly rejects?: { readonly errorName: string };
  readonly answer: string;
  readonly iterations: number;
  readonly usage: TokenUsageJson;
  readonly cost: UsageCostJson | null;
  readonly failure: LlmFailureJson | null;
  readonly modelRequestCount: number;
  readonly eventSequence: readonly string[];
  readonly toolCalls: readonly ExpectedToolCall[];
  readonly trajectoryCount: number;
  readonly trajectory?: readonly AgentMessageJson[];
}

export interface LoopFixture {
  readonly id: string;
  readonly kind?: "loop";
  readonly scenario: string;
  readonly description: string;
  readonly source?: {
    readonly tests?: readonly string[];
    readonly docs?: string;
  };
  readonly input: LoopFixtureInput;
  readonly expected: LoopFixtureExpected;
}

export interface HostRecoveryFixture {
  readonly id: string;
  readonly kind: "host-recovery";
  readonly scenario: string;
  readonly description: string;
  readonly source?: {
    readonly tests?: readonly string[];
    readonly docs?: string;
  };
  readonly input: {
    readonly sessionId: string;
    readonly checkpointState: string;
    readonly attemptedPrompt: string;
    readonly checkpointedTrajectory: readonly AgentMessageJson[];
  };
  readonly expected: {
    readonly blocksAutoRetry: boolean;
    readonly requires: string;
    readonly modelRequestCount: number;
    readonly toolCalls: readonly unknown[];
  };
}

export type Fixture = LoopFixture | HostRecoveryFixture;

export function isLoopFixture(value: Fixture): value is LoopFixture {
  return (value.kind ?? "loop") === "loop";
}

// ---------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

/** Read a known string field; pushes an error when missing/wrong. */
function checkString(record: JsonRecord, key: string, path: string, errors: string[]): string | null {
  const value = record[key];
  if (!isString(value)) {
    errors.push(`${path}.${key}: expected string`);
    return null;
  }
  return value;
}

/** Read a known number field; pushes an error when missing/wrong. */
function checkNumber(record: JsonRecord, key: string, path: string, errors: string[]): number | null {
  const value = record[key];
  if (!isNumber(value)) {
    errors.push(`${path}.${key}: expected number`);
    return null;
  }
  return value;
}

function checkBoolean(record: JsonRecord, key: string, path: string, errors: string[]): boolean | null {
  const value = record[key];
  if (!isBoolean(value)) {
    errors.push(`${path}.${key}: expected boolean`);
    return null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Vocabulary pieces
// ---------------------------------------------------------------------------

const VALID_FINISH_REASONS = new Set(["stop", "tool-calls", "max-tokens"]);
const VALID_STOP_REASONS = new Set<StopReason>([
  "answer",
  "final_output_tool",
  "max_iterations",
  "error",
  "interrupted",
  "context_limit",
]);

function checkToolCall(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected object`);
    return;
  }
  checkString(value, "id", path, errors);
  checkString(value, "name", path, errors);
  checkString(value, "arguments", path, errors);
}

function checkContentBlock(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected object`);
    return;
  }
  const type = checkString(value, "type", path, errors);
  if (type === "text") checkString(value, "text", path, errors);
  if (type === "tool-call") {
    checkString(value, "id", path, errors);
    checkString(value, "name", path, errors);
    checkString(value, "arguments", path, errors);
  }
  // reasoning / image / file / opaque blocks only need a type for now.
}

/** Validates one message in the @di/ai AgentMessage union shape. */
function checkAgentMessage(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected object`);
    return;
  }
  const role = checkString(value, "role", path, errors);
  if (role === "system") {
    checkString(value, "text", path, errors);
  } else if (role === "user" || role === "assistant") {
    const content = value.content;
    if (!Array.isArray(content)) {
      errors.push(`${path}.content: expected array`);
      return;
    }
    content.forEach((block, index) => checkContentBlock(block, `${path}.content[${index}]`, errors));
  } else if (role === "tool") {
    checkString(value, "toolCallId", path, errors);
    checkString(value, "content", path, errors);
    checkBoolean(value, "isError", path, errors);
  } else if (role !== null) {
    errors.push(`${path}.role: unknown role ${JSON.stringify(role)}`);
  }
}

function checkTokenUsage(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected object`);
    return;
  }
  checkNumber(value, "inputTokens", path, errors);
  checkNumber(value, "outputTokens", path, errors);
  // Optional numeric fields are not validated further.
}

function checkUsageCost(value: unknown, path: string, errors: string[]): void {
  if (value === null) return;
  if (!isRecord(value)) {
    errors.push(`${path}: expected object or null`);
    return;
  }
  checkNumber(value, "input", path, errors);
  checkNumber(value, "output", path, errors);
  checkNumber(value, "cacheRead", path, errors);
  checkNumber(value, "cacheWrite", path, errors);
}

function checkLlmFailure(value: unknown, path: string, errors: string[]): void {
  if (value === null) return;
  if (!isRecord(value)) {
    errors.push(`${path}: expected object or null`);
    return;
  }
  checkString(value, "message", path, errors);
  checkString(value, "code", path, errors);
}

function checkToolSpec(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected object`);
    return;
  }
  checkString(value, "name", path, errors);
  checkString(value, "description", path, errors);
  if (!isRecord(value.parameters)) {
    errors.push(`${path}.parameters: expected object (JSON Schema payload)`);
  }
}

function checkModelStep(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected object`);
    return;
  }
  // A failure step rejects the model call; the completed-step fields must be absent.
  if ("failure" in value && value.failure !== null) {
    checkLlmFailure(value.failure, `${path}.failure`, errors);
    return;
  }
  const text = value.text;
  if (text !== null && !isString(text)) {
    errors.push(`${path}.text: expected string or null`);
  }
  const toolCalls = value.toolCalls;
  if (!Array.isArray(toolCalls)) {
    errors.push(`${path}.toolCalls: expected array`);
  } else {
    toolCalls.forEach((call, index) => checkToolCall(call, `${path}.toolCalls[${index}]`, errors));
  }
  const finishReason = value.finishReason;
  if (!isString(finishReason) || !VALID_FINISH_REASONS.has(finishReason)) {
    errors.push(`${path}.finishReason: expected one of stop|tool-calls|max-tokens`);
  }
  checkTokenUsage(value.usage, `${path}.usage`, errors);
  checkUsageCost(value.cost, `${path}.cost`, errors);
  checkString(value, "model", path, errors);
}

function checkModelScript(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected object`);
    return;
  }
  const responses = value.responses;
  if (!Array.isArray(responses)) {
    errors.push(`${path}.responses: expected array`);
  } else {
    responses.forEach((step, index) => checkModelStep(step, `${path}.responses[${index}]`, errors));
  }
  if (value.fallback !== undefined) checkModelStep(value.fallback, `${path}.fallback`, errors);
}

function checkInterruptScript(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected object`);
    return;
  }
  if (value.softStopAfterTurn !== undefined) {
    const n = checkNumber(value, "softStopAfterTurn", path, errors);
    if (n !== null && n <= 0) errors.push(`${path}.softStopAfterTurn: must be a positive turn number`);
  }
  if (value.cancelAfterTool !== undefined) checkBoolean(value, "cancelAfterTool", path, errors);
}

// ---------------------------------------------------------------------------
// Top-level validation
// ---------------------------------------------------------------------------

function checkSource(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`${path}: expected object`);
    return;
  }
  if (value.docs !== undefined) checkString(value, "docs", path, errors);
  if (value.tests !== undefined && !Array.isArray(value.tests)) {
    errors.push(`${path}.tests: expected array`);
  }
}

function validateLoopInput(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected object`);
    return;
  }
  checkString(value, "sessionId", path, errors);
  checkString(value, "systemPrompt", path, errors);
  checkString(value, "userMessage", path, errors);
  const history = value.history;
  if (!Array.isArray(history)) {
    errors.push(`${path}.history: expected array`);
  } else {
    history.forEach((message, index) => checkAgentMessage(message, `${path}.history[${index}]`, errors));
  }
  if (value.systemContext !== null && !isString(value.systemContext)) {
    errors.push(`${path}.systemContext: expected string or null`);
  }
  const tools = value.tools;
  if (!Array.isArray(tools)) {
    errors.push(`${path}.tools: expected array`);
  } else {
    tools.forEach((tool, index) => checkToolSpec(tool, `${path}.tools[${index}]`, errors));
  }
  if (value.contextTokenBudget !== null) {
    const budget = checkNumber(value, "contextTokenBudget", path, errors);
    if (budget !== null && budget < 0) errors.push(`${path}.contextTokenBudget: must be >= 0 (0 = unconditional pause)`);
  }
  const maxIterations = checkNumber(value, "maxIterations", path, errors);
  if (maxIterations !== null && maxIterations < 0) errors.push(`${path}.maxIterations: must be >= 0 (0 = unlimited)`);
  if (value.maxTokens !== null) {
    const maxTokens = checkNumber(value, "maxTokens", path, errors);
    if (maxTokens !== null && maxTokens <= 0) errors.push(`${path}.maxTokens: must be a positive integer`);
  }
  if (value.reasoningEffort !== null && !isString(value.reasoningEffort)) {
    errors.push(`${path}.reasoningEffort: expected string or null`);
  }
  if (value.finalOutputTool !== null && !isString(value.finalOutputTool)) {
    errors.push(`${path}.finalOutputTool: expected string or null`);
  }
  if (value.interrupt !== undefined) checkInterruptScript(value.interrupt, `${path}.interrupt`, errors);
  checkModelScript(value.model, `${path}.model`, errors);
}

function validateLoopExpected(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected object`);
    return;
  }
  const stopReason = value.stopReason;
  if (stopReason !== null && (!isString(stopReason) || !VALID_STOP_REASONS.has(stopReason as StopReason))) {
    errors.push(`${path}.stopReason: expected one of the StopReason union or null`);
  }
  if (value.rejects !== undefined) {
    if (!isRecord(value.rejects) || !isNonEmptyString(value.rejects.errorName)) {
      errors.push(`${path}.rejects: expected { errorName: string }`);
    }
  }
  checkString(value, "answer", path, errors);
  const iterations = checkNumber(value, "iterations", path, errors);
  if (iterations !== null && iterations < 0) errors.push(`${path}.iterations: must be >= 0`);
  checkTokenUsage(value.usage, `${path}.usage`, errors);
  checkUsageCost(value.cost, `${path}.cost`, errors);
  checkLlmFailure(value.failure, `${path}.failure`, errors);
  const modelRequestCount = checkNumber(value, "modelRequestCount", path, errors);
  if (modelRequestCount !== null && modelRequestCount < 0) errors.push(`${path}.modelRequestCount: must be >= 0`);
  const eventSequence = value.eventSequence;
  if (!Array.isArray(eventSequence)) {
    errors.push(`${path}.eventSequence: expected array`);
  } else {
    eventSequence.forEach((name, index) => {
      if (!isNonEmptyString(name)) errors.push(`${path}.eventSequence[${index}]: expected string`);
    });
  }
  const toolCalls = value.toolCalls;
  if (!Array.isArray(toolCalls)) {
    errors.push(`${path}.toolCalls: expected array`);
  } else {
    toolCalls.forEach((call, index) => {
      if (!isRecord(call)) {
        errors.push(`${path}.toolCalls[${index}]: expected object`);
        return;
      }
      checkString(call, "id", `${path}.toolCalls[${index}]`, errors);
      checkString(call, "name", `${path}.toolCalls[${index}]`, errors);
      checkString(call, "arguments", `${path}.toolCalls[${index}]`, errors);
      checkString(call, "observation", `${path}.toolCalls[${index}]`, errors);
      checkBoolean(call, "isError", `${path}.toolCalls[${index}]`, errors);
    });
  }
  const trajectoryCount = checkNumber(value, "trajectoryCount", path, errors);
  if (trajectoryCount !== null && trajectoryCount < 0) errors.push(`${path}.trajectoryCount: must be >= 0`);
  if (value.trajectory !== undefined) {
    if (!Array.isArray(value.trajectory)) {
      errors.push(`${path}.trajectory: expected array`);
    } else {
      value.trajectory.forEach((message, index) => checkAgentMessage(message, `${path}.trajectory[${index}]`, errors));
    }
  }
}

function validateLoopFixture(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("fixture: expected object");
    return;
  }
  checkSource(value.source, "fixture.source", errors);
  validateLoopInput(value.input, "fixture.input", errors);
  validateLoopExpected(value.expected, "fixture.expected", errors);
}

function validateHostRecoveryFixture(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("fixture: expected object");
    return;
  }
  checkSource(value.source, "fixture.source", errors);
  const input = value.input;
  if (!isRecord(input)) {
    errors.push("fixture.input: expected object");
    return;
  }
  checkString(input, "sessionId", "fixture.input", errors);
  checkString(input, "checkpointState", "fixture.input", errors);
  checkString(input, "attemptedPrompt", "fixture.input", errors);
  const trajectory = input.checkpointedTrajectory;
  if (!Array.isArray(trajectory)) {
    errors.push("fixture.input.checkpointedTrajectory: expected array");
  } else {
    trajectory.forEach((message, index) =>
      checkAgentMessage(message, `fixture.input.checkpointedTrajectory[${index}]`, errors),
    );
  }
  const expected = value.expected;
  if (!isRecord(expected)) {
    errors.push("fixture.expected: expected object");
    return;
  }
  checkBoolean(expected, "blocksAutoRetry", "fixture.expected", errors);
  checkString(expected, "requires", "fixture.expected", errors);
  checkNumber(expected, "modelRequestCount", "fixture.expected", errors);
  if (!Array.isArray(expected.toolCalls)) {
    errors.push("fixture.expected.toolCalls: expected array");
  }
}

/**
 * Validates one fixture against the documented schema.
 * Returns an array of human-readable errors; an empty array means valid.
 */
export function validateFixture(value: unknown): readonly string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["fixture: expected object"];
  }
  if (!isNonEmptyString(value.id)) {
    errors.push("fixture.id: expected non-empty string");
  }
  const scenario = checkString(value, "scenario", "fixture", errors);
  if (scenario !== null && !isNonEmptyString(scenario)) {
    errors.push("fixture.scenario: expected non-empty string");
  }
  checkString(value, "description", "fixture", errors);
  const kind = value.kind === undefined ? "loop" : value.kind;
  if (kind === "loop") validateLoopFixture(value, errors);
  else if (kind === "host-recovery") validateHostRecoveryFixture(value, errors);
  else errors.push(`fixture.kind: unknown kind ${JSON.stringify(value.kind)}`);
  return errors;
}
