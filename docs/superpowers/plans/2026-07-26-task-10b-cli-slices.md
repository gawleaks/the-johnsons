# Task 10b CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a usable `the-johnsons` terminal CLI that selects a saved policy preset, validates role models through Pi RPC, starts/resumes/lists durable runs, and documents safe operation.

**Architecture:** Keep command parsing, terminal interaction, policy-preset persistence, and Pi process composition separate. The CLI is a thin adapter: it parses commands, builds injected `RunController` dependencies, and delegates workflow decisions to the existing controller. Each role uses a persistent `PiRpcAgentProcess`; a small role-agent adapter converts its JSON result into controller-required structured text.

**Tech Stack:** Node.js 24+, TypeScript 5.9 ESM, Node `readline/promises`, Vitest 4.1, Pi RPC through `PiRpcAgentProcess`, existing `ArtifactStore`, `WorkspaceManager`, and `RunController`.

## Global Constraints

- Preserve the existing deterministic controller as the authoritative workflow engine.
- Persist run policy before agent dispatch; resume uses the persisted run policy, never changed defaults.
- Never print or persist credentials.
- Reviewer role configuration must remain read-only: no `edit`, `write`, or `bash`.
- Metadata mode never invokes Git; Git mode remains behind `WorkspaceManager`’s injected command adapter.
- Use Node built-ins and existing dependencies only.
- Every slice follows test-first development and is reviewer-gated before the next slice.
- Do not push Git commits.

---

## Slice 10b.1: File-backed policy presets and command parser

**Files:**
- Create: `src/cli/arguments.ts`
- Create: `src/cli/presets.ts`
- Create: `test/cli/arguments.test.ts`
- Create: `test/cli/presets.test.ts`

**Interfaces:**
- Produces `parseCommand(argv): Command` where `Command` is exactly:

```ts
export type Command =
  | { readonly type: "start"; readonly workspace: string; readonly preset?: string }
  | { readonly type: "resume"; readonly workspace: string; readonly runId: string }
  | { readonly type: "runs"; readonly workspace: string };
```

- Produces `PresetStore`:

```ts
export interface PresetStore {
  list(workspace: string): Promise<Readonly<Record<string, Policy>>>;
  save(workspace: string, name: string, policy: Policy): Promise<void>;
}
```

- Presets live at `<workspace>/.johnsons/presets.json`; the default preset name is `default` and resolves to `defaultPolicy` if no file exists.

- [ ] **Step 1: Write failing parser/preset tests**

```ts
it("parses start with workspace and preset", () => {
  expect(parseCommand(["start", "--workspace", "/repo", "--preset", "fast"])).toEqual({
    type: "start", workspace: "/repo", preset: "fast",
  });
});

it("rejects an unknown command and missing resume run id", () => {
  expect(() => parseCommand(["destroy"])).toThrow("Unknown command");
  expect(() => parseCommand(["resume"])).toThrow("run id");
});

it("uses default policy when no preset file exists", async () => {
  await expect(store.list(tempWorkspace)).resolves.toEqual({ default: defaultPolicy });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- test/cli/arguments.test.ts test/cli/presets.test.ts`

Expected: FAIL because the CLI modules do not exist.

- [ ] **Step 3: Implement minimal parser and atomic preset store**

```ts
export const parseCommand = (argv: readonly string[]): Command => {
  const [type, ...rest] = argv;
  const option = (name: string): string | undefined => {
    const index = rest.indexOf(name);
    return index < 0 ? undefined : rest[index + 1];
  };
  const workspace = resolve(option("--workspace") ?? process.cwd());
  // validate exact supported flags per command; reject duplicate/unknown flags
};
```

Use `ArtifactStore`’s existing atomic file primitive (`atomicWrite`) for presets. Parse JSON into `Policy` with `validatePolicy`; reject unknown preset names and malformed persisted policies. Never include environment variables, auth values, or provider credentials in a preset.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- test/cli/arguments.test.ts test/cli/presets.test.ts && npm run typecheck && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/arguments.ts src/cli/presets.ts test/cli/arguments.test.ts test/cli/presets.test.ts
git commit -m "feat: add CLI commands and policy presets"
```

### Slice 10b.1 Review

- [ ] Run: `npm test -- test/cli/arguments.test.ts test/cli/presets.test.ts && npm run typecheck && npm run build`
- [ ] Confirm parser rejects unsupported input and preset persistence is path-contained, atomic, credential-free, and policy-validated.
- [ ] Obtain reviewer approval before Slice 10b.2.

## Slice 10b.2: Terminal UI and Pi role-agent composition

**Files:**
- Create: `src/ui/terminal.ts`
- Create: `src/cli/role-agent.ts`
- Create: `test/ui/terminal.test.ts`
- Create: `test/cli/role-agent.test.ts`

**Interfaces:**
- Produces `TerminalRunUi implements RunUi` using injected `TerminalIo`:

```ts
export interface TerminalIo {
  choose(title: string, options: readonly string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  ask(title: string): Promise<string>;
  write(line: string): void;
}
```

- Produces `selectPolicy(io, presets): Promise<{ name: string; policy: Policy }>`; user selects a preset and may override a role’s model or thinking level before start.
- Produces `PiRoleAgent implements RoleAgent`, maintaining one `PiRpcAgentProcess` per role and returning the final assistant text from each `AgentProcessResult`.
- Produces `validateModels(policy, modelCatalog): void` that rejects any unavailable configured `provider/model` before a run starts.

- [ ] **Step 1: Write failing UI/composition tests**

```ts
it("returns no approval until terminal confirmation is true", async () => {
  const ui = new TerminalRunUi(fakeIo({ confirm: false }));
  await expect(ui.approveSpecification("spec")).resolves.toBe(false);
});

it("rejects a policy whose reviewer model is unavailable", () => {
  expect(() => validateModels(defaultPolicy, ["openai/gpt-5.6-sol"])).toThrow("anthropic/sonnet-5");
});

it("returns the final assistant text from the configured role process", async () => {
  const roleAgent = new PiRoleAgent(fakeProcessFactory);
  await expect(roleAgent.prompt("architect", "handoff")).resolves.toBe('{"specification":"x"}');
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- test/ui/terminal.test.ts test/cli/role-agent.test.ts`

Expected: FAIL because UI and role-agent modules do not exist.

- [ ] **Step 3: Implement minimal terminal and role adapters**

Use `node:readline/promises` only in the production `createTerminalIo()` adapter. Tests inject `TerminalIo`; they never read stdin. `choose` repeats only for an invalid option; `confirm` accepts only `y`/`yes` as true. Display policy assignment before confirmation, including role/model/thinking values.

`PiRoleAgent` receives an injected factory:

```ts
export type AgentProcessFactory = (role: Role, config: RoleConfig) => AgentProcess;
```

It caches the agent by role, calls `process.prompt(handoff)`, finds the last assistant text inside returned messages, and throws if none exists. It must close all cached processes in `close()`.

Model validation uses a short-lived Pi RPC child started with a lightweight configured model, sends `{ "id": "catalog", "type": "get_available_models" }`, and compares returned `provider/id` strings. Keep protocol code behind `loadAvailableModels()`; tests inject a catalog loader.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- test/ui/terminal.test.ts test/cli/role-agent.test.ts && npm run typecheck && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/terminal.ts src/cli/role-agent.ts test/ui/terminal.test.ts test/cli/role-agent.test.ts
git commit -m "feat: add terminal UI and Pi role agents"
```

### Slice 10b.2 Review

- [ ] Run: `npm test -- test/ui/terminal.test.ts test/cli/role-agent.test.ts && npm run typecheck && npm run build`
- [ ] Confirm all model assignments are shown/validated before dispatch, UI remains injectable, role processes remain isolated by role, and no credentials are stored/displayed.
- [ ] Obtain reviewer approval before Slice 10b.3.

## Slice 10b.3: CLI composition, runs listing, and documentation

**Files:**
- Create: `src/cli.ts`
- Create: `test/cli.test.ts`
- Create: `README.md`
- Modify: `package.json` only if required to ensure the built CLI has an executable shebang

**Interfaces:**
- Consumes `parseCommand`, `PresetStore`, `TerminalRunUi`, `PiRoleAgent`, `WorkspaceManager`, `ArtifactStore`, `RunController`, and `createRunState`.
- Produces `main(argv, dependencies): Promise<number>` for testable command composition.

- [ ] **Step 1: Write failing end-to-end CLI composition tests**

```ts
it("starts a run after policy confirmation and persists its selected policy", async () => {
  const result = await main(["start", "--workspace", tempWorkspace], fakeDependencies);
  expect(result).toBe(0);
  expect(fakeDependencies.createdRun.policy).toEqual(defaultPolicy);
});

it("resumes an existing run with its persisted policy rather than current defaults", async () => {
  await main(["resume", "run-1", "--workspace", tempWorkspace], fakeDependencies);
  expect(fakeDependencies.controller.resume).toHaveBeenCalledOnce();
});

it("lists durable run IDs and phases", async () => {
  await main(["runs", "--workspace", tempWorkspace], fakeDependencies);
  expect(fakeIo.output).toContain("run-1");
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- test/cli.test.ts`

Expected: FAIL because `src/cli.ts` does not exist.

- [ ] **Step 3: Implement command composition**

`start`:

1. Parse command and load presets.
2. Select/override/confirm policy through `TerminalRunUi`.
3. Validate policy and available models.
4. Prepare workspace with `WorkspaceManager`.
5. Generate a run ID from `randomUUID()`.
6. Create `ArtifactStore` using `createRunState(runId, preparedWorkspace)`.
7. Persist `policy.json` before `RunController.start()`.
8. Close role processes in `finally`.

`resume`:

1. Open the selected run’s artifact store using a new `ArtifactStore.open(workspace, runId)` method added with focused tests in this slice.
2. Load and validate its `policy.json`.
3. Build dependencies from the persisted policy.
4. Invoke `RunController.resume()`.
5. Close role processes in `finally`.

`runs`: inspect `.johnsons/runs/*/state.json`, print `runId` and phase in lexical run-ID order, and return success when no runs exist.

The executable footer is:

```ts
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main(process.argv.slice(2), createProductionDependencies()).then((code) => process.exitCode = code);
}
```

Translate validation/user-input errors to exit code `2`; unexpected errors to `1`, without stack traces unless `JOHNSONS_DEBUG=1`.

- [ ] **Step 4: Write the operational README**

Document exact setup and commands:

```text
npm install
npm run build
node dist/cli.js start --workspace /path/to/project
node dist/cli.js resume <run-id> --workspace /path/to/project
node dist/cli.js runs --workspace /path/to/project
```

Include Pi installation/authentication, role model preset/override selection, metadata versus Git mode, reviewer read-only enforcement caveat, run artifact layout, resumability, no-secret policy, and the explicit statement that subprocesses are not a security sandbox.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- test/cli.test.ts && npm test && npm run typecheck && npm run build && node dist/cli.js runs --workspace "$(mktemp -d)"`

Expected: all tests/build pass; `runs` exits 0 with no run output.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/storage/artifact-store.ts test/cli.test.ts test/storage/artifact-store.test.ts README.md package.json
git commit -m "feat: add harness CLI"
```

### Slice 10b.3 Review

- [ ] Run: `npm test && npm run typecheck && npm run build`
- [ ] Confirm `start` persists selected policy before dispatch; `resume` uses `policy.json`; `runs` is read-only; all role processes close in `finally`; README includes every required safety/setup statement.
- [ ] Obtain reviewer approval before final project verification.

## Plan self-review

- **Scope:** This splits the formerly broad Task 10b into three independently reviewable outputs: persistence/parser, interactive role composition, and command composition/docs.
- **Coverage:** Startup policy selection and availability checks are Slice 10b.2/10b.3; `start`, `resume`, and `runs` are Slice 10b.3; persisted-policy resume is explicitly covered; README safety requirements are explicit.
- **Dependency consistency:** Slice 10b.1 creates `Command`/`PresetStore`; Slice 10b.2 creates `TerminalRunUi`/`PiRoleAgent`; Slice 10b.3 composes all of them and adds `ArtifactStore.open` only where needed.
- **No placeholders:** All command behavior, persistence locations, response shapes, and verification commands are concrete.
