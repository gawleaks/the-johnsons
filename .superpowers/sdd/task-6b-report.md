# Task 6b report

## Recovery diagnosis
- Root cause of the interruption: test callbacks used `const process = createProcess(...)`, shadowing Node's global `process` and throwing in the TDZ before the subject existed.
- First genuine failure after that fix: malformed RPC output rejected with a plain `Error: Invalid RPC JSON` instead of `MalformedRpcOutputError`.
- Second genuine failure during full verification: compiled tests in `dist/` could not find `dist/package.json` and the fake RPC helper, so the build/test path failed even though source tests passed.

## RED / GREEN evidence
### RED
- `npm test -- test/rpc/agent-process.test.ts`
  - failed with `ReferenceError: Cannot access 'process' before initialization`
- After the fixture fix, same command failed on malformed output:
  - `expected Error: Invalid RPC JSON to be an instance of MalformedRpcOutputError`
- `npm test`
  - failed on missing `dist/package.json`
  - failed on compiled agent-process tests when the helper asset was not copied into `dist/`

### GREEN
- `npm test -- test/rpc/agent-process.test.ts` ✅
- `npm run build` ✅
- `npm run typecheck` ✅
- `npm test` ✅

## Commands run
- `npm test -- test/rpc/agent-process.test.ts`
- `npm test`
- `npm run build`
- `npm run typecheck`
- `npm test`

## Concerns
- Build now copies `test/helpers` and `package.json` into `dist/`; any future non-TS runtime assets will need the same treatment.
- Timeout grace and close settling are now covered by regression tests.

## Task 6b reviewer follow-up
- Added regression tests for timeout abort + grace termination and close settling a pending prompt.
- `npm test -- test/rpc/agent-process.test.ts` ✅
- `npm run typecheck` ✅
- `npm test` ✅
- `npm run build` ✅

## Final review fix evidence
- Added RED/GREEN coverage for:
  - decoder reset across child restart
  - stale timeout grace not SIGTERMing restarted child
  - signal exit classified as `PrematureNonzeroExitError`
- Fixed `src/rpc/agent-process.ts` to recreate per-child decoders, capture grace-kill target, clear grace timer on exit, and classify signal exits as nonzero.
- Fresh verification:
  - `npm test -- test/rpc/agent-process.test.ts` ✅
  - `npm test` ✅
  - `npm run typecheck` ✅
  - `npm run build` ✅
