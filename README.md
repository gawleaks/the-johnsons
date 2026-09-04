# the-johnsons

Terminal harness for running the Johnsons workflow with Pi role agents.

## Setup

```bash
npm install
npm run build
```

Install Pi and authenticate before starting a run:

```bash
npm install -g @earendil-works/pi-coding-agent
pi auth login
```

The CLI uses your existing Pi auth. It does not accept secrets on the command line and should not store provider credentials in presets, env files committed to the repo, or run artifacts.

## Real Pi smoke test

This is opt-in and uses your local Pi authentication. Supply a configured model explicitly:

```bash
JOHNSONS_REAL_PI_MODEL=provider/model npm run smoke:pi
```

It sends a minimal prompt to Pi RPC and creates only a temporary session directory.

## Commands

```bash
node dist/cli.js start --workspace /path/to/project
node dist/cli.js start --workspace /path/to/project --preset default
node dist/cli.js resume <run-id> --workspace /path/to/project
node dist/cli.js runs --workspace /path/to/project
```

`start` loads saved presets from `/path/to/project/.johnsons/presets.json`, lets you confirm per-role model and thinking overrides in the terminal, validates the chosen models against Pi's live model catalog, writes `policy.json`, then starts the run.

`resume` reuses the persisted `policy.json` from the selected run. It does **not** re-read current defaults or preset changes.

`runs` is read-only. It reads `.johnsons/runs/*/state.json` and prints `run-id<TAB>phase` in lexical run-id order.

## Presets and role overrides

Presets are policies saved in `.johnsons/presets.json`. The default preset is `default` when no preset file exists. You can pin a preset with `--preset <name>`, then override individual role models or thinking levels during `start`.

Reviewer configs must stay read-only. Reviewer tools cannot include `edit`, `write`, or `bash`.

## Workspace modes

Policies choose the checkpoint mode:

- `metadata`: run in the current workspace and track progress in `.johnsons/`
- `git`: create a detached git worktree under `.johnsons/worktrees/<run-id>` before controller start

Metadata mode is the simpler default. Git mode is about workspace isolation, not stronger trust boundaries.

## Artifacts and resume

Run artifacts live under:

```text
<workspace>/.johnsons/runs/<run-id>/
```

Important files:

- `state.json`: latest durable state
- `transitions.jsonl`: transition log
- `policy.json`: persisted policy used for start and resume
- `specification.md`, `plan.md`, `chunks/...`: workflow artifacts
- `sessions/`: Pi RPC session directories for role subprocesses

Resume depends on those artifacts. Keep `.johnsons/runs/<run-id>/policy.json` and `state.json` intact.

## Safety notes

- Pi subprocesses are **not** a sandbox.
- Do not put secrets in prompts, presets, specs, plans, reviews, or artifacts.
- Git mode worktrees and metadata mode workspaces both run local subprocesses with your user permissions.
- Model validation happens before workspace preparation so bad model selections fail early.
