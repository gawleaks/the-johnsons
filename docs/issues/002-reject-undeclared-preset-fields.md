# Reject undeclared fields in persisted policies

## Problem

Policy preset loading delegates to `validatePolicy()`, which accepts extra fields. Hand-edited JSON can therefore persist undeclared data, including secret-looking values.

## Expected behavior

The preset trust boundary accepts only the declared `Policy` and `RoleConfig` fields and their expected scalar/list types. Unknown fields reject on both load and save.

## Acceptance criteria

- A persisted policy with an undeclared root field rejects.
- A persisted role configuration with an undeclared field rejects.
- `PresetStore.save()` rejects policy input with undeclared fields.
- A valid policy round-trips unchanged.
- No environment values, credentials, or provider auth settings are serialized.

## Scope

- `src/cli/presets.ts`
- `test/cli/presets.test.ts`
