# Task 10a Slice 2 Report

## Scope
- Added planner dispatch from `planning` only.
- Parsed strict planner output `{ chunks: [{ id }] }`.
- Wrote `plan.md` and per-chunk `chunks/<id>/definition.md` artifacts.
- Normalized chunks to pending state and advanced to `developing` with the first chunk active.
- Kept slice 1 architect/spec behavior unchanged.

## RED evidence
Focused controller tests failed first because slice 2 behavior was missing:

```text
8 failed
```

Initial failures covered missing planner wiring, invalid plan rejection, and artifact writes.

## GREEN evidence
Focused controller tests passed after implementation:

```text
Test Files  1 passed (1)
Tests       13 passed (13)
```

## Verification
- `npm test -- test/orchestrator/run-controller.test.ts`
  - passed
- `npm test`
  - passed: 18 files, 124 tests
- `npm run typecheck`
  - passed
- `npm run build`
  - passed

## Notes
- Planner receives the exact stored specification handoff.
- Invalid, empty, duplicate, extra-field, and non-object chunk plans now fail before transitions or plan artifacts.

## 2026-08-20 approved contract update
- Replaced the slice 2 planner tests with the full chunk-definition contract: `id`, `scope`, `nonGoals`, `prerequisites`, `touchedAreas`, `acceptanceCriteria`, `requiredChecks`, `handoffArtifacts`, `recoveryNotes`.
- `plan.md` now stays as the full planner JSON and each `chunks/<id>/definition.md` stores the full validated chunk definition.
- Runtime normalization stays limited to workflow `ChunkState` fields: `id`, `status`, `reviewAttempts`.

### Evidence
- RED: `npm test -- test/orchestrator/run-controller.test.ts`
  - failed first with `2 failed`
- GREEN: `npm test -- test/orchestrator/run-controller.test.ts`
  - passed: `38 passed`
- Full: `npm test`
  - passed: `9 passed`, `91 passed`
- Typecheck: `npm run typecheck`
  - passed
- Build: `npm run build`
  - passed
