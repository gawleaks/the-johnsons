# Enforce resume command argument order

## Problem

`parseCommand()` accepts `resume --workspace /repo run-1`, although the documented grammar is `resume <run-id> [--workspace <path>]`.

## Expected behavior

`resume` requires its run ID as the first positional argument after the command. Optional `--workspace` follows it.

## Acceptance criteria

- `resume run-1 --workspace /repo` parses successfully.
- `resume run-1` uses the resolved current directory as workspace.
- `resume --workspace /repo run-1` rejects with an argument-order error.
- Missing, unsafe, duplicated, and extra run arguments reject.

## Scope

- `src/cli/arguments.ts`
- `test/cli/arguments.test.ts`
