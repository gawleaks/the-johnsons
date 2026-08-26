# Empty presets file incorrectly falls back to default

## Problem

`PresetStore.list()` returns `{ default: defaultPolicy }` when `presets.json` exists but contains `{}`.

## Expected behavior

The default preset is synthesized only when `<workspace>/.johnsons/presets.json` is absent (`ENOENT`). An existing empty file represents an empty preset collection and must load as `{}`.

## Acceptance criteria

- An absent preset file loads as `{ default: defaultPolicy }`.
- An existing file containing `{}` loads as `{}`.
- Existing valid named presets load unchanged.
- Tests cover all three cases.

## Scope

- `src/cli/presets.ts`
- `test/cli/presets.test.ts`
