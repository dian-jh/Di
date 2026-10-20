# Cross-language fixtures

Location decision (P1.2): **repo-root `fixtures/`**. The migration docs specify a
fixture location only for the P5 session-format fixtures
(`packages/coding-agent/test/fixtures/sessions/`, owned by `@di/coding-agent`);
no location was specified for the loop fixtures, so this directory was chosen and
recorded here and in `docs/migration/typescript-core/progress.md`. The P5 session
fixtures stay out of this directory to avoid mixing loop and JSONL-format assets.

## Purpose

These JSON files are the single shared input/expected contract between the C#
baseline (`09f4e0816c1b2dc42461e79a968b46e811d3880c`) and the TypeScript core.
The minimal scenario set comes from `docs/migration/typescript-core/execution-plan.md`
P1 item 5: pure answer, tool round-trip, error, soft-stop, hard-cancel,
budget-pause, recovery.

**Provenance rule (operator-guide.md):** every `expected` value is derived from the
C# baseline source/tests or the leaf migration docs — never from generated TS
output. Each fixture's `source.tests` lists the baseline test(s) it is extracted
from. Normalize volatile values (timestamps, ids) and keep invariant values exact
(`call_id`, `name`, raw `arguments` string, message ordering).

## Files

| file | scenario | kind |
|---|---|---|
| `pure-answer.json` | `pure-answer` | loop |
| `tool-round-trip.json` | `tool-round-trip` | loop |
| `error.json` | `error` | loop |
| `soft-stop.json` | `soft-stop` | loop |
| `hard-cancel.json` | `hard-cancel` | loop |
| `budget-pause.json` | `budget-pause` | loop |
| `recovery.json` | `recovery` | host-recovery |
| `schema.json` | — | machine-readable JSON Schema reference |

## Schema

`schema.json` is the machine-readable reference; this section is the readable
contract. A structural validator encoding these rules lives in
`packages/agent/test/fixture-schema.ts` and is enforced by the P1.2 node:test
(`npm test -w @di/agent`).

Top level:

| field | type | notes |
|---|---|---|
| `id` | string | unique fixture id |
| `kind` | `"loop"` \| `"host-recovery"` | default `loop` |
| `scenario` | string | one of the seven scenarios |
| `description` | string | what it covers + provenance note |
| `source` | object (optional) | `baseline`, `tests[]`, `docs` provenance |
| `input` | object | see below |
| `expected` | object | see below |

### `kind: "loop"` input

Mirrors `@di/agent` `AgentRequest` plus a scripted fake model and optional
interrupt timing. `history` and `tools` use the `@di/ai` `AgentMessage` and
`ToolSpec` JSON shapes.

| field | type | notes |
|---|---|---|
| `sessionId` | string | stable per fixture |
| `systemPrompt` / `userMessage` | string | loop context |
| `history` | `AgentMessage[]` | cross-turn memory |
| `systemContext` | string \| null | volatile trailing system message |
| `tools` | `ToolSpec[]` | model-facing schemas |
| `contextTokenBudget` | number \| null | `0` = unconditional pause |
| `maxIterations` | number | `0` = unlimited |
| `maxTokens` | number \| null | per-call output cap |
| `reasoningEffort` | string \| null | opaque |
| `finalOutputTool` | string \| null | arguments become the answer |
| `interrupt` | object (optional) | timing script: `softStopAfterTurn` (request soft stop right after the n-th model call returns, before tool execution) or `cancelAfterTool` (abort the run signal after the first tool executes) |
| `model` | `{ responses: ModelStep[], fallback?: ModelStep }` | scripted fake model; `fallback` repeats when `responses` are exhausted |

`ModelStep` is one of:

- completed response: `{ text: string|null, toolCalls: {id,name,arguments}[],
  finishReason: "stop"|"tool-calls"|"max-tokens", usage, cost|null, model }`
- failure: `{ failure: { message, code, ... } }` — the model call rejects with
  this `LlmFailure` fact.

### `kind: "loop"` expected

| field | type | notes |
|---|---|---|
| `stopReason` | `StopReason` \| null | null only when the run rejects |
| `rejects` | `{ errorName }` (optional) | hard-cancel: `AbortError` rejection |
| `answer` | string | final visible text |
| `iterations` | number | model calls executed |
| `usage` / `cost` | `TokenUsage` / `UsageCost` \| null | accumulated across calls |
| `failure` | `LlmFailure` \| null | set when `stopReason === "error"` |
| `modelRequestCount` | number | requests sent to the model |
| `eventSequence` | string[] | camelCase `AgentEvent` types in order |
| `toolCalls` | `{id,name,arguments,observation,isError}[]` | expected executor invocations, in order |
| `trajectoryCount` | number | message count |
| `trajectory` | `AgentMessage[]` (optional) | full expected trajectory |

For a rejecting run (`rejects`), `stopReason` is null and the remaining fields
document the observable partial state at the abort point (not a returned
`AgentResult`).

### `kind: "host-recovery"`

Documents the host-level fail-closed boundary (P5, `AgentSession`), not a
pure-loop run.

`input`: `{ sessionId, checkpointState, attemptedPrompt, checkpointedTrajectory }`.
`expected`: `{ blocksAutoRetry: boolean, requires: string, modelRequestCount, toolCalls }`.

## Consumption

- P1.2 (this wave): `packages/agent/test/fixtures.test.ts` validates every
  fixture against the schema and drives the recording executor through
  `tool-round-trip.json` to prove recording/replay works.
- P2: the pure loop validates its behavior against the `kind: "loop"` fixtures
  with the fake model + recording executor.
- P5: the session host validates the `kind: "host-recovery"` fixture.
