# Task 8b Report

## Status
Done.

## Files
- `src/workspace/workspace-manager.ts`
- `test/workspace/workspace-manager.test.ts`

## Checks
- `npm test -- test/workspace/workspace-manager.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm test`

## Notes
- Metadata mode resolves the workspace path and never calls the injected adapter.
- Git mode routes `git worktree add --detach` through the injected adapter only.
- Snapshots hash regular files in deterministic path order and skip `.johnsons`, `node_modules`, `.git`, and `dist`.
- `assertUnchanged` raises `ExternalWorkspaceChange` when snapshot contents differ.
