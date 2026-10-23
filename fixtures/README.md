# Agent loop fixtures

Loop fixtures live in the repository-root `fixtures/` directory. Session format
fixtures live separately in `packages/coding-agent/test/fixtures/sessions/`.

## Purpose

These JSON files define the inputs and expected outputs for the TypeScript agent
loop tests. They cover pure answers, tool round trips, errors, soft stops, hard
cancellation, budget pauses, and host recovery.

Each fixture's optional `source.tests` and `source.docs` fields point to current
TypeScript tests and documentation. Normalize volatile values (timestamps, ids)
and keep invariant values exact
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
`packages/agent/test/fixture-schema.ts` and is enforced by the agent package tests.

Top level:

| field | type | notes |
|---|---|---|
| `id` | string | unique fixture id |
| `kind` | `"loop"` \| `"host-recovery"` | default `loop` |
| `scenario` | string | one of the seven scenarios |
| `description` | string | what it covers + provenance note |
| `source` | object (optional) | Current test and documentation references |
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

Documents the host-level fail-closed boundary in `AgentSession`, rather than a
pure-loop run.

`input`: `{ sessionId, checkpointState, attemptedPrompt, checkpointedTrajectory }`.
`expected`: `{ blocksAutoRetry: boolean, requires: string, modelRequestCount, toolCalls }`.

## Consumption

- `packages/agent/test/fixtures.test.ts` validates every
  fixture against the schema and drives the recording executor through
  `tool-round-trip.json` to prove recording/replay works.
- The pure loop validates its behavior against the `kind: "loop"` fixtures
  with the fake model + recording executor.
- The session host validates the `kind: "host-recovery"` fixture.
