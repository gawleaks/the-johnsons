# Task 10a Controller Recovery Plan

**Goal:** Build the deterministic orchestration core as four small, independently reviewed slices.

**Constraints:** TypeScript strict ESM; workflow and artifact store are authoritative; test-first; no direct Pi spawning or CLI here; no credentials in artifacts; Git commits allowed; no pushes.

## Slice 1: Controller contracts and architect approval

**Files:**
- Create: `src/orchestrator/run-controller.ts`
- Create: `test/orchestrator/run-controller.test.ts`
- Create: `test/helpers/fake-agent.ts`

**Behavior:** Define injected `RoleAgent`, `RunUi`, and artifact dependency interfaces. `RunController.start()` loads state and dispatches the architect only from `architecting`. It parses `{ "specification": string }`, writes `specification.md`, persists `specification-created`, asks UI approval, and persists `specification-approved` only when approved. Rejection leaves the run in `awaiting-spec-approval` without dispatching planner.

**Check:** tests prove specification artifact persistence, explicit approval gate, invalid architect output rejection, and no planner dispatch.

## Slice 2: Planner and chunk initialization

**Files:**
- Modify: `src/orchestrator/run-controller.ts`
- Modify: `test/orchestrator/run-controller.test.ts`

**Behavior:** From `planning`, dispatch planner with specification handoff. Parse a full ordered plan: `{ "chunks": [{ "id", "scope", "nonGoals", "prerequisites", "touchedAreas", "acceptanceCriteria", "requiredChecks", "handoffArtifacts", "recoveryNotes" }] }`. Reject empty/duplicate/unsafe IDs and incomplete chunk definitions. Normalize only runtime fields (`status: "pending"`, `reviewAttempts: 0`), write the full planner output to `plan.md`, write each full chunk definition to `chunks/<id>/definition.md`, then persist `plan-created`. Enter `developing` with the first chunk active.

**Check:** tests prove plan/chunk artifacts, invalid plans rejected before transitions, and ordered first-chunk activation.

## Slice 3: Developer/reviewer loop and escalation

**Files:**
- Modify: `src/orchestrator/run-controller.ts`
- Modify: `test/orchestrator/run-controller.test.ts`

**Behavior:** From `developing`, dispatch developer for the active chunk and parse `{ "report": string, "deviated": boolean }`; write implementation report before transition. A deviation escalates without review. From `reviewing`, dispatch reviewer and parse `{ "verdict", "report" }`; write attempt-numbered review before transition. Drive through rejection retries, approval to next chunk/completion, and escalation.

**Check:** tests prove rejection retry increments only active chunk, review approval completion, retry exhaustion, and deviation bypasses reviewer.

## Slice 4: Durable resume and user questions

**Files:**
- Modify: `src/orchestrator/run-controller.ts`
- Modify: `test/orchestrator/run-controller.test.ts`

**Behavior:** `resume()` reloads durable state and drives only the current phase. `answerUserQuestion()` asks UI, persists `questions/<increment>.json`, and returns the answer. An escalated run invokes `resolveEscalation`; resume choice applies `user-escalated-resolution` then continues, stop choice reaches `failed`.

**Check:** tests prove resume does not repeat architect/planner artifacts, questions persist, and both escalation decisions are durable.

## Reviews

After every slice: focused test, full test, typecheck, build, commit, task-scoped review. Task 10a is complete only after all four slices are approved.
