# The Johnsons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `the-johnsons`, a durable TypeScript CLI that orchestrates architect, planner, developer, and reviewer Pi RPC agents through human-approved, reviewer-gated implementation chunks.

**Architecture:** A deterministic Workflow Engine owns durable state and transitions; Pi RPC processes supply isolated role agents behind an `AgentProcess` interface. Artifact storage is authoritative and atomic, while Pi session files are resumable supporting evidence. Workspace and policy modules provide configurable checkpoint behavior, tool constraints, required checks, and model presets.

**Tech Stack:** Node.js 24+, TypeScript 5.9, ESM, Vitest 4.1, `@earendil-works/pi-coding-agent` 0.81.1, Node `readline`-free stream handling, Pi RPC JSONL.

## Global Constraints

- Create a standalone ESM TypeScript CLI named `the-johnsons`.
- Pin Pi coding agent to `0.81.1`; reject a child Pi version outside that exact major/minor compatibility policy.
- The Workflow Engine and Artifact Store, not Pi sessions, are authoritative.
- All plan work is arranged into reviewable chunks. A chunk is complete only after its review task confirms its required checks.
- Use test-first development for all new behavior.
- Do not run Git commands in this workspace. Metadata-only mode must never invoke Git; Git-mode behavior is tested with injected command adapters.
- Never persist credentials or copy them into prompts, state, reports, or logs.
- Reviewer execution must be read-only: no `edit`, `write`, or unrestricted `bash` tool profile.

---

## File structure

```text
package.json                         Project metadata, scripts, dependencies, CLI binary
package-lock.json                    Locked dependencies after installation
tsconfig.json                        Strict ESM TypeScript configuration
src/cli.ts                           Command parsing and interactive run/resume entry point
src/domain/types.ts                  Branded domain types and persistent state/artifact schemas
src/domain/workflow.ts               Pure workflow state machine and transition validation
src/domain/review.ts                 Review verdict/acceptance-criteria validation
src/storage/files.ts                 Atomic JSON/text persistence primitives
src/storage/artifact-store.ts        Run creation, artifact paths, transition log, recovery reads
src/rpc/jsonl.ts                     Strict LF-only JSONL decoder and encoder
src/rpc/agent-process.ts             Persistent Pi RPC subprocess adapter and supervision
src/policy/config.ts                 Presets, role definitions, policy validation and model resolution
src/policy/prompts.ts                Versioned role prompts and artifact handoff construction
src/workspace/workspace-manager.ts   Current-tree/worktree lifecycle and external-change snapshotting
src/orchestrator/run-controller.ts   Coordinates state, artifacts, processes, workspace, and user gates
src/ui/terminal.ts                   Terminal prompts, model selection, events, and escalation UI
test/domain/workflow.test.ts         Workflow transition and retry tests
test/domain/review.test.ts           Verdict and approval validation tests
test/storage/artifact-store.test.ts  Atomic persistence and recovery tests
test/rpc/jsonl.test.ts               RPC framing tests
test/rpc/agent-process.test.ts       Subprocess/RPC contract tests using a fake child
test/policy/config.test.ts           Preset and role-policy validation tests
test/workspace/workspace-manager.test.ts Workspace safety tests with injected command adapter
test/orchestrator/run-controller.test.ts End-to-end deterministic fake-agent workflow tests
test/helpers/fake-agent.ts           Scripted AgentProcess adapter
test/helpers/fake-pi-rpc.mjs         JSONL fake process fixture
README.md                            Setup, model configuration, safety model, and use examples
```

## Chunk 1 — Bootstrap and domain state machine

### Task 1: Create the strict project shell and immutable domain model

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/domain/types.ts`
- Create: `test/domain/workflow.test.ts`

**Interfaces:**
- Produces `RunState`, `RunPhase`, `ChunkState`, `Role`, `ReviewVerdict`, and `Transition` types for all later tasks.
- Produces `npm test`, `npm run typecheck`, and `npm run build` scripts.

- [ ] **Step 1: Write the failing domain test**

```ts
import { describe, expect, it } from "vitest";
import { createRunState } from "../../src/domain/types.js";

describe("createRunState", () => {
  it("starts awaiting an architect specification", () => {
    expect(createRunState("run-1", "/repo").phase).toBe("architecting");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- test/domain/workflow.test.ts`

Expected: FAIL because the project and `src/domain/types.ts` do not exist.

- [ ] **Step 3: Create project metadata and TypeScript configuration**

```json
{
  "name": "the-johnsons",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "the-johnsons": "dist/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "dev": "tsx src/cli.ts"
  },
  "engines": { "node": ">=24.0.0" },
  "dependencies": { "@earendil-works/pi-coding-agent": "0.81.1" },
  "devDependencies": { "@types/node": "24.12.4", "tsx": "4.21.0", "typescript": "5.9.3", "vitest": "4.1.9" }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2024", "module": "NodeNext", "moduleResolution": "NodeNext",
    "outDir": "dist", "strict": true,
    "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true, "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 4: Implement the domain types**

```ts
export type Role = "architect" | "planner" | "developer" | "reviewer";
export type RunPhase = "architecting" | "awaiting-spec-approval" | "planning" |
  "developing" | "reviewing" | "escalated" | "completed" | "failed";
export type ReviewVerdict = "approved" | "rejected" | "escalate";
export interface ChunkState { id: string; status: "pending" | "developing" | "reviewing" | "approved" | "escalated"; reviewAttempts: number; }
export interface RunState { version: 1; runId: string; workspace: string; phase: RunPhase; chunks: ChunkState[]; activeChunkId?: string; transitionId: number; }
export const createRunState = (runId: string, workspace: string): RunState => ({ version: 1, runId, workspace, phase: "architecting", chunks: [], transitionId: 0 });
```

- [ ] **Step 5: Run focused verification**

Run: `npm install && npm test -- test/domain/workflow.test.ts && npm run typecheck`

Expected: test PASS and TypeScript exits 0.

### Task 2: Implement the pure workflow transition state machine

**Files:**
- Create: `src/domain/workflow.ts`
- Modify: `src/domain/types.ts`
- Modify: `test/domain/workflow.test.ts`

**Interfaces:**
- Consumes `RunState`, `RunPhase`, and `ReviewVerdict`.
- Produces `applyTransition(state, transition, policy): RunState` and `WorkflowError`.

- [ ] **Step 1: Add failing transition tests**

```ts
it("requires explicit specification approval before planning", () => {
  const state = { ...createRunState("r", "/repo"), phase: "awaiting-spec-approval" as const };
  expect(() => applyTransition(state, { type: "plan-created" }, policy)).toThrow("specification approval");
  expect(applyTransition(state, { type: "specification-approved" }, policy).phase).toBe("planning");
});

it("does not complete a chunk before reviewer approval", () => {
  const state = stateReviewingChunk();
  expect(() => applyTransition(state, { type: "chunk-completed" }, policy)).toThrow("reviewer approval");
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- test/domain/workflow.test.ts`

Expected: FAIL because `applyTransition` is missing.

- [ ] **Step 3: Define closed transition input types and implementation**

```ts
export type Transition =
  | { type: "specification-created" }
  | { type: "specification-approved" }
  | { type: "plan-created"; chunks: ChunkState[] }
  | { type: "developer-finished" }
  | { type: "reviewed"; verdict: ReviewVerdict }
  | { type: "user-escalated-resolution"; resume: boolean };

export class WorkflowError extends Error {}

export function applyTransition(state: RunState, transition: Transition, policy: { maxReviewAttempts: number }): RunState {
  if (transition.type === "specification-approved" && state.phase === "awaiting-spec-approval") return { ...state, phase: "planning", transitionId: state.transitionId + 1 };
  if (transition.type === "plan-created" && state.phase === "planning") return { ...state, chunks: transition.chunks, activeChunkId: transition.chunks[0]?.id, phase: "developing", transitionId: state.transitionId + 1 };
  throw new WorkflowError(`Invalid transition ${transition.type} from ${state.phase}`);
}
```

Complete the `developer-finished`, `reviewed`, and `user-escalated-resolution` branches so that rejection increments only the active chunk's attempt; attempts at or over `maxReviewAttempts`, plan deviations, and `escalate` select `escalated`; only `approved` advances to the next chunk or `completed`.

- [ ] **Step 4: Run all state-machine cases**

Run: `npm test -- test/domain/workflow.test.ts && npm run typecheck`

Expected: PASS; tests cover invalid ordering, rejection retry, exhaustion, escalation, and final completion.

### Task 3: Review Chunk 1

**Files:**
- Review: `package.json`, `tsconfig.json`, `src/domain/types.ts`, `src/domain/workflow.ts`, `test/domain/workflow.test.ts`

- [ ] **Step 1: Verify quality gates**

Run: `npm test -- test/domain/workflow.test.ts && npm run typecheck && npm run build`

Expected: all commands exit 0.

- [ ] **Step 2: Confirm Chunk 1 acceptance criteria**

- Explicit spec approval is the only transition into planning.
- A chunk reaches `approved` only from reviewer `approved`.
- Review retry exhaustion and a plan deviation reach `escalated`.

- [ ] **Step 3: Mark Chunk 1 complete only on approval**

Record reviewer verdict `approved` in the plan tracking artifact. If any criterion fails, record `rejected` and return to the applicable task; do not continue.

## Chunk 2 — Durable artifacts and recovery

### Task 4: Add atomic artifact persistence

**Files:**
- Create: `src/storage/files.ts`
- Create: `src/storage/artifact-store.ts`
- Create: `test/storage/artifact-store.test.ts`

**Interfaces:**
- Produces `ArtifactStore.createRun`, `writeText`, `writeJson`, `appendTransition`, and `loadState`.
- All writes resolve beneath `.johnsons/runs/<runId>`.

- [ ] **Step 1: Write failing atomic-write and recovery tests**

```ts
it("persists state atomically and reloads the latest transition", async () => {
  const store = await ArtifactStore.create(tempDir, "run-1", createRunState("run-1", tempDir));
  await store.appendTransition({ type: "specification-created" }, { ...createRunState("run-1", tempDir), phase: "awaiting-spec-approval" });
  expect((await store.loadState()).phase).toBe("awaiting-spec-approval");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- test/storage/artifact-store.test.ts`

Expected: FAIL because `ArtifactStore` does not exist.

- [ ] **Step 3: Implement atomic primitives and store path validation**

```ts
export async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

export class ArtifactStore {
  static async create(workspace: string, runId: string, initial: RunState): Promise<ArtifactStore> {
    const store = new ArtifactStore(resolve(workspace, ".johnsons", "runs", runId));
    await store.writeJson("state.json", initial);
    return store;
  }
  async writeJson(name: string, value: unknown): Promise<void> {
    await atomicWrite(this.resolveName(name), `${JSON.stringify(value, null, 2)}\n`);
  }
  async appendTransition(transition: Transition, next: RunState): Promise<void> {
    await appendFile(this.resolveName("transitions.jsonl"), `${JSON.stringify({ transition, next, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    await this.writeJson("state.json", next);
  }
  async loadState(): Promise<RunState> {
    const value: unknown = JSON.parse(await readFile(this.resolveName("state.json"), "utf8"));
    if (!isRunStateV1(value)) throw new Error("Invalid run state");
    return value;
  }
}
```

Store specifications at `specification.md`, plans at `plan.md`, questions as numbered JSON files, chunks beneath `chunks/<id>/`, and session file paths in `state.json`; never store prompt credentials.

- [ ] **Step 4: Run persistence verification**

Run: `npm test -- test/storage/artifact-store.test.ts && npm run typecheck`

Expected: PASS, including rejected traversal path, recovery after a stray `.tmp` file, and transition ordering.

### Task 5: Review Chunk 2

**Files:**
- Review: `src/storage/files.ts`, `src/storage/artifact-store.ts`, `test/storage/artifact-store.test.ts`

- [ ] **Step 1: Verify quality gates**

Run: `npm test -- test/storage/artifact-store.test.ts && npm run typecheck && npm run build`

Expected: all commands exit 0.

- [ ] **Step 2: Confirm Chunk 2 acceptance criteria**

- Every state update is atomic.
- State and artifacts cannot escape the run directory.
- Restart reloads the last fully persisted state without relying on a Pi session.

- [ ] **Step 3: Mark Chunk 2 complete only on approval**

Record reviewer verdict before beginning RPC work.

## Chunk 3 — Pi RPC supervision

### Task 6: Implement strict JSONL decoding and persistent AgentProcess

**Files:**
- Create: `src/rpc/jsonl.ts`
- Create: `src/rpc/agent-process.ts`
- Create: `test/rpc/jsonl.test.ts`
- Create: `test/rpc/agent-process.test.ts`
- Create: `test/helpers/fake-pi-rpc.mjs`

**Interfaces:**
- Produces `JsonlDecoder.push(chunk): unknown[]`, `PiRpcAgentProcess`, and the `AgentProcess` interface.
- `prompt` resolves only on Pi's `agent_settled` event for the accepted request.

- [ ] **Step 1: Write failing LF framing tests**

```ts
it("does not split JSON strings at Unicode line separators", () => {
  const decoder = new JsonlDecoder();
  expect(decoder.push('{"text":"a\u2028b"}\n')).toEqual([{ text: "a\u2028b" }]);
});

it("rejects malformed JSONL records", () => {
  expect(() => new JsonlDecoder().push("not-json\n")).toThrow("Invalid RPC JSON");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- test/rpc/jsonl.test.ts test/rpc/agent-process.test.ts`

Expected: FAIL because RPC modules are absent.

- [ ] **Step 3: Implement decoder and RPC lifecycle**

```ts
export class JsonlDecoder {
  #buffer = "";
  push(chunk: Buffer | string): unknown[] {
    this.#buffer += chunk.toString();
    const records = this.#buffer.split("\n");
    this.#buffer = records.pop() ?? "";
    return records.filter(Boolean).map((record) => JSON.parse(record.endsWith("\r") ? record.slice(0, -1) : record));
  }
}

export interface AgentProcess {
  start(config: AgentConfig): Promise<void>;
  prompt(request: AgentRequest): Promise<AgentResult>;
  abort(): Promise<void>;
  close(): Promise<void>;
}
```

Spawn `pi --mode rpc --session-dir <run-session-dir> --name <role-run-name> --model <provider/id:thinking>`. Send JSON commands with unique IDs. Correlate `response` records by ID, collect events after prompt acceptance, and settle only after `agent_settled`. On idle or total timeout send `{"type":"abort"}`, then terminate after the grace interval. Capture stderr in the result. Treat decoder errors, nonzero exit, and premature exit as typed `AgentProcessError` values.

- [ ] **Step 4: Add fake-child contract coverage**

Make `fake-pi-rpc.mjs` emit a prompt response followed by `message_end` and `agent_settled`; add tests for successful prompt, malformed output, timeout/abort, nonzero exit, and session restart command construction.

- [ ] **Step 5: Run RPC verification**

Run: `npm test -- test/rpc/jsonl.test.ts test/rpc/agent-process.test.ts && npm run typecheck`

Expected: PASS.

### Task 7: Review Chunk 3

**Files:**
- Review: `src/rpc/jsonl.ts`, `src/rpc/agent-process.ts`, `test/rpc/*.test.ts`, `test/helpers/fake-pi-rpc.mjs`

- [ ] **Step 1: Verify quality gates**

Run: `npm test -- test/rpc && npm run typecheck && npm run build`

Expected: all commands exit 0.

- [ ] **Step 2: Confirm Chunk 3 acceptance criteria**

- JSONL splits only on LF, preserving Unicode line separators inside JSON.
- Prompt completion waits for `agent_settled`.
- Abort, grace timeout, process crash, malformed output, and stderr are surfaced as typed failures.
- No credentials are logged or persisted by the supervisor.

- [ ] **Step 3: Mark Chunk 3 complete only on approval**

Record reviewer verdict before policy/UI work.

## Chunk 4 — Policy, workspace, and role contracts

### Task 8: Implement policy/preset validation and safe workspace adapters

**Files:**
- Create: `src/policy/config.ts`
- Create: `src/policy/prompts.ts`
- Create: `src/workspace/workspace-manager.ts`
- Create: `test/policy/config.test.ts`
- Create: `test/workspace/workspace-manager.test.ts`

**Interfaces:**
- Produces `validatePolicy`, `RoleConfig`, `buildRoleHandoff`, and `WorkspaceManager`.
- Consumes project workspace path and selected preset.

- [ ] **Step 1: Write failing policy and workspace tests**

```ts
it("rejects a reviewer profile containing write or unrestricted bash tools", () => {
  expect(() => validatePolicy({ roles: { reviewer: { tools: ["read", "write"] } } })).toThrow("reviewer");
});

it("metadata mode never invokes the command adapter", async () => {
  const commands = { run: vi.fn() };
  await new WorkspaceManager({ mode: "metadata", commands }).prepare("/repo", "r");
  expect(commands.run).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- test/policy/config.test.ts test/workspace/workspace-manager.test.ts`

Expected: FAIL because policy and workspace modules are absent.

- [ ] **Step 3: Implement policy defaults and role handoffs**

```ts
export interface RoleConfig { model: string; thinking: "off" | "low" | "medium" | "high" | "max"; tools: string[]; timeoutMs: number; }
export interface Policy { maxReviewAttempts: number; checkpointMode: "metadata" | "git"; roles: Record<Role, RoleConfig>; requiredChecks: string[]; }
export function validatePolicy(policy: Policy): Policy {
  if (!Number.isInteger(policy.maxReviewAttempts) || policy.maxReviewAttempts < 1) throw new Error("maxReviewAttempts must be at least 1");
  const forbidden = policy.roles.reviewer.tools.filter((tool) => ["edit", "write", "bash"].includes(tool));
  if (forbidden.length > 0) throw new Error(`reviewer tools are not read-only: ${forbidden.join(", ")}`);
  return policy;
}
export function buildRoleHandoff(role: Role, artifacts: { specification?: string; plan?: string; chunk?: string; review?: string }): string {
  const allowed = role === "reviewer" ? [artifacts.specification, artifacts.plan, artifacts.chunk] : [artifacts.specification, artifacts.plan, artifacts.chunk, artifacts.review];
  return allowed.filter((value): value is string => value !== undefined).join("\n\n---\n\n");
}
```

Define initial preset values: architect `openai/gpt-5.6-sol` at `max`; planner `openai/gpt-5.6-terra` at `high`; developer `moonshot/kimi-k2.7` at `high`; reviewer `anthropic/sonnet-5` at `high`. Include role prompts that require structured Markdown/JSON artifacts and explicitly require plan-deviation escalation.

- [ ] **Step 4: Implement workspace behavior with injected commands**

```ts
export interface CommandAdapter { run(command: string, args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }>; }
export class WorkspaceManager {
  async prepare(workspace: string, runId: string): Promise<{ path: string }> {
    if (this.mode === "metadata") return { path: resolve(workspace) };
    const path = resolve(workspace, ".johnsons", "worktrees", runId);
    const result = await this.commands.run("git", ["worktree", "add", "--detach", path], workspace);
    if (result.exitCode !== 0) throw new Error(`worktree creation failed: ${result.stdout}`);
    return { path };
  }
  async captureSnapshot(path: string): Promise<Record<string, string>> {
    return Object.fromEntries(await Promise.all((await listFiles(path)).map(async (file) => [relative(path, file), createHash("sha256").update(await readFile(file)).digest("hex")] as const)));
  }
  async assertUnchanged(before: Record<string, string>, path: string): Promise<void> {
    if (JSON.stringify(before) !== JSON.stringify(await this.captureSnapshot(path))) throw new ExternalWorkspaceChange(path);
  }
}
```

Git commands exist only inside the Git-mode adapter path; tests use a fake adapter and must not execute Git.

- [ ] **Step 5: Run policy/workspace verification**

Run: `npm test -- test/policy/config.test.ts test/workspace/workspace-manager.test.ts && npm run typecheck`

Expected: PASS.

### Task 9: Review Chunk 4

**Files:**
- Review: `src/policy/*.ts`, `src/workspace/workspace-manager.ts`, related tests

- [ ] **Step 1: Verify quality gates**

Run: `npm test -- test/policy test/workspace && npm run typecheck && npm run build`

Expected: all commands exit 0.

- [ ] **Step 2: Confirm Chunk 4 acceptance criteria**

- Startup policy includes per-role model, thinking, tools, and timeout.
- Reviewer cannot obtain mutation tools through a valid policy.
- Metadata mode runs no Git command.
- Git behavior is isolated behind an injected adapter and worktree mode.

- [ ] **Step 3: Mark Chunk 4 complete only on approval**

Record reviewer verdict before controller implementation.

## Chunk 5 — Controller, CLI, and end-to-end behavior

### Task 10: Implement orchestration, interactive selection, and resume

**Files:**
- Create: `src/orchestrator/run-controller.ts`
- Create: `src/ui/terminal.ts`
- Create: `src/cli.ts`
- Create: `test/helpers/fake-agent.ts`
- Create: `test/orchestrator/run-controller.test.ts`
- Create: `README.md`

**Interfaces:**
- Consumes `ArtifactStore`, `AgentProcess`, `Policy`, `WorkspaceManager`, and terminal UI.
- Produces `RunController.start`, `resume`, and `answerUserQuestion`.

- [ ] **Step 1: Write the deterministic end-to-end failing test**

```ts
it("runs architect approval, a reviewed chunk, and completes", async () => {
  const agents = scriptedAgents({ architect: [specification], planner: [planWithOneChunk], developer: [implementationReport], reviewer: [approvedVerdict] });
  const controller = await createController({ agents, ui: approvingUi, workspace: tempDir });
  await controller.start();
  expect((await controller.state()).phase).toBe("completed");
  expect(await controller.readArtifact("chunks/01/review-01.md")).toContain("approved");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- test/orchestrator/run-controller.test.ts`

Expected: FAIL because `RunController` does not exist.

- [ ] **Step 3: Implement controller phase dispatch**

```ts
export class RunController {
  async start(): Promise<void> { return this.drive(await this.store.loadState()); }
  async resume(): Promise<void> { return this.drive(await this.store.loadState()); }
  async drive(state: RunState): Promise<void> {
    switch (state.phase) {
      case "architecting": return this.runArchitect(state);
      case "awaiting-spec-approval": return this.requestSpecificationApproval(state);
      case "planning": return this.runPlanner(state);
      case "developing": return this.runDeveloper(state);
      case "reviewing": return this.runReviewer(state);
      case "escalated": return this.requestEscalationResolution(state);
      default: return;
    }
  }
}
```

Before every agent dispatch, persist a `dispatching` transition record. After an agent settles, validate its structured artifact, persist it, then persist the workflow transition. Route architect approval through the UI; route all role questions through `Terminal.askQuestion` and persist question/answer pairs. Any developer plan deviation moves directly to `escalated` without invoking reviewer.

- [ ] **Step 4: Implement the terminal CLI contract**

Support:

```text
the-johnsons start [--workspace <path>] [--preset <name>]
the-johnsons resume <run-id> [--workspace <path>]
the-johnsons runs [--workspace <path>]
```

`start` displays saved presets, permits per-role model and thinking overrides, validates model availability through a short-lived Pi RPC `get_available_models` request, then persists the policy snapshot before creating agents. `resume` loads `state.json` and reuses the run's persisted policy, not current defaults.

- [ ] **Step 5: Document safe setup and operation**

README must include Pi installation/authentication, `npm install`, model/preset selection, metadata vs Git mode, reviewer read-only caveat, run layout, resume behavior, and exact commands above. State clearly that subprocesses are not a security sandbox.

- [ ] **Step 6: Run controller verification**

Run: `npm test -- test/orchestrator/run-controller.test.ts && npm run typecheck && npm run build`

Expected: all commands exit 0; test covers approval, rejection/retry, retry exhaustion, plan deviation escalation, durable resume, and reviewer approval completion.

### Task 11: Review Chunk 5 and release verification

**Files:**
- Review: all `src/**`, `test/**`, `README.md`, `package.json`

- [ ] **Step 1: Run complete automated verification**

Run: `npm test && npm run typecheck && npm run build`

Expected: all commands exit 0.

- [ ] **Step 2: Run opt-in real Pi smoke test**

Run: `PI_SMOKE_TEST=1 npm test -- test/rpc/agent-process.test.ts`

Expected: PASS when Pi is authenticated and the selected smoke-test model is available; otherwise the test is skipped with an explicit message.

- [ ] **Step 3: Confirm final acceptance criteria**

- Architect cannot hand work to the planner without explicit user approval.
- Planner artifacts always provide reviewable chunks and required checks.
- Developer/reviewer loops cannot mark a chunk complete without reviewer approval.
- Retry exhaustion and plan deviations escalate to the user.
- Interrupted runs resume from the last durable transition.
- Role-specific model presets are interactively selectable and persisted per run.
- Metadata mode makes no Git invocation; Git mode uses isolated worktree behavior.
- Reviewer receives only read-only tools and independently verifies required checks.

- [ ] **Step 4: Mark Chunk 5 and the implementation plan complete only on approval**

Record the reviewer verdict and final check evidence. Do not claim implementation completion without this approval.

## Plan self-review

- **Spec coverage:** Tasks 1–3 implement workflow state and review gates; Tasks 4–5 implement authoritative durable artifacts; Tasks 6–7 implement persistent Pi RPC supervision; Tasks 8–9 implement presets, policy, workspace modes, and reviewer constraints; Tasks 10–11 implement interactive operation, recovery, documentation, and end-to-end verification.
- **No Git conflict:** No task instructs running a Git command. Git-mode behavior is confined to an injected adapter and fake-adapter tests.
- **Chunk requirement:** Every implementation chunk has an explicit review task and can advance only after reviewer approval.
- **Type consistency:** `RunState`, `Transition`, `Policy`, `AgentProcess`, `ArtifactStore`, and `WorkspaceManager` are introduced before their consumers.
