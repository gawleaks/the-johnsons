# The Johnsons Harness Design

## Purpose

`the-johnsons` is a standalone TypeScript CLI harness for a durable, human-governed, four-role software-delivery workflow:

1. **Architect** — collaborates with the user to produce and revise a feature specification.
2. **Planner** — translates an approved specification into an ordered, reviewable implementation plan.
3. **Developer** — implements one active plan chunk at a time.
4. **Reviewer** — independently verifies the active chunk and returns a structured verdict.

The harness, not an LLM, owns the workflow state machine. It uses persistent Pi RPC subprocesses for role agents, allowing independent model assignment and future replacement of local agent processes with remote workers.

## Goals

- Require explicit user approval of the architect's specification before planning.
- Require every plan to consist of independently reviewable chunks.
- Mark a chunk complete only after an explicit reviewer approval.
- Persist enough authoritative state and artifacts to resume safely after process restart.
- Select models interactively at startup through presets with per-role overrides.
- Support both metadata-only and Git/worktree checkpoint strategies.
- Keep all role handoffs explicit, compact, and auditable.

## Non-goals for the first version

- Distributed execution, despite designing an adapter seam that enables it later.
- Parallel developer writes.
- Treating a subprocess as a security sandbox.
- Automatic resolution of material plan deviations; they always escalate to the user.

## Architecture

```text
User <-> Terminal Interface
           |
           v
     Workflow Engine  <---->  Artifact Store (authoritative)
           |
           +--> Policy Engine
           +--> Workspace Manager
           +--> Agent Supervisor
                   |
                   +--> Architect Pi RPC process
                   +--> Planner Pi RPC process
                   +--> Developer Pi RPC process
                   +--> Reviewer Pi RPC process
```

### Workflow Engine

The Workflow Engine is the authoritative deterministic state machine. Its interface accepts user input and agent results, validates transitions, persists transitions through the Artifact Store, and returns the next permitted action. It owns:

- specification approval gates;
- planning and chunk sequencing;
- developer/reviewer feedback loops;
- retry limits and escalation states;
- completion state.

Pi session history is supporting evidence only. It is never the authoritative workflow state.

### Agent Supervisor

The Agent Supervisor implements an `AgentProcess` interface using persistent local Pi RPC child processes. It owns strict JSONL framing, command correlation, streamed event handling, RPC UI requests, cancellation, timeouts, stderr capture, crash detection, and session restoration.

```ts
interface AgentProcess {
  start(config: AgentConfig): Promise<void>;
  prompt(request: AgentRequest): Promise<AgentResult>;
  abort(): Promise<void>;
  close(): Promise<void>;
}
```

The rest of the harness depends only on this interface. Future local subprocess, SSH, container, or queue-worker adapters may satisfy it.

### Artifact Store

The Artifact Store atomically persists all externally meaningful artifacts and state transitions. A state transition is valid only after its required artifact has been persisted. It provides recovery and auditing without relying on opaque agent context.

### Workspace Manager

The Workspace Manager selects the configured mode:

- **metadata-only**: use the current working directory and never invoke Git;
- **Git mode**: create an isolated worktree for the run and optionally commit an approved chunk.

It enforces one active writer. Review begins only after the developer settles and the changed-file/diff manifest is captured.

### Policy Engine

The Policy Engine resolves role prompts, model and thinking assignments, tool profiles, timeouts, retry limits, required checks, checkpoint strategy, and safety configuration.

### Terminal Interface

The terminal interface provides interactive preset/model selection, user conversations, approval prompts, escalations, progress, run inspection, and resume controls.

## Workflow

```text
Architect <-> User
  -> approved specification
  -> Planner
  -> chunked plan
  -> for each chunk:
       Developer -> implementation report + evidence
       Reviewer  -> approved | rejected | escalate
         rejected -> developer retry, up to configured limit
         retry limit reached -> user escalation
       approved -> mark chunk complete
  -> run complete
```

### Required transition rules

- Planning may start only after explicit user approval of the current specification.
- The planner must create ordered chunks, each with acceptance criteria and required checks.
- The developer may implement only the active chunk.
- The reviewer is read-only and may run only configured non-mutating checks.
- A chunk is complete only when the reviewer returns `approved`.
- If implementation reveals a plan deviation, the harness pauses and escalates directly to the user.
- All roles may ask the user questions. Questions and answers are durable run artifacts.
- Reviewer rejection retries are capped by configured policy. Exhaustion produces a user escalation.

## Run layout

```text
.johnsons/
  runs/<run-id>/
    state.json
    specification.md
    plan.md
    questions/
    chunks/01-.../
      definition.md
      implementation-report.md
      test-evidence.json
      review-01.md
      review-02.md
      status.json
    sessions/
      architect.jsonl
      planner.jsonl
      developer.jsonl
      reviewer-<chunk>-<attempt>.jsonl
```

`state.json` records run identity, policy snapshot, role models, current workflow state, chunk statuses, attempts, durable transition IDs, workspace information, and escalation state.

## Role contracts

| Role | Responsibility | Tool profile |
|---|---|---|
| Architect | Elicit requirements, create/revise specification, obtain user approval | Read-only project inspection; user interaction |
| Planner | Produce chunked plan, acceptance criteria, checks, and handoffs | Read-only inspection; user interaction |
| Developer | Implement exactly one active chunk and report evidence/deviations | Read/write/code execution |
| Reviewer | Verify the chunk independently and return a verdict | Read-only inspection plus configured non-mutating checks; user interaction |

Role handoffs use artifacts, not full transcripts. The reviewer does not receive developer reasoning by default, reducing anchoring.

## Model selection and presets

Startup loads saved presets, shows an interactive picker, permits per-role overrides, and validates that each selected model is configured and authenticated before the run begins.

An initial example preset is:

```text
architect  openai/gpt-5.6-sol       thinking: max
planner    openai/gpt-5.6-terra     thinking: high
developer  moonshot/kimi-k2.7       thinking: configured
reviewer   anthropic/sonnet-5       thinking: high
```

A preset includes each role's model, thinking level, prompt, allowed tools, and timeout.

## Plan and review contracts

Each chunk definition must include:

- scope and non-goals;
- prerequisites and touched areas;
- acceptance criteria with stable IDs;
- required commands/checks;
- expected handoff artifacts;
- rollback or recovery notes where relevant.

The developer reports changed files, commands run, results, and deviations. The reviewer returns:

```json
{
  "verdict": "approved | rejected | escalate",
  "summary": "...",
  "findings": [
    {
      "severity": "blocker | major | minor",
      "location": "path:line",
      "problem": "...",
      "requiredFix": "..."
    }
  ],
  "acceptanceCriteria": [{"id": "AC-1", "status": "pass"}],
  "checks": [{"command": "...", "status": "pass", "evidence": "..."}]
}
```

Approval requires every required acceptance criterion and check to pass, unless the user has explicitly approved a recorded exception.

## Reliability and safety

- Persist required artifacts and state transitions before dispatching the next phase.
- On restart, reconcile state with Pi child sessions and resume from the last durable transition.
- Apply startup, idle, total-run, and graceful-abort timeouts to every child process.
- On timeout, issue RPC `abort`, wait for the grace period, force-terminate if necessary, persist the failure, and offer retry/model-change/escalation options.
- Pin and validate the compatible Pi version at startup.
- Treat malformed RPC output as a child-process failure.
- Keep credentials in Pi authentication configuration or environment variables; never serialize them to artifacts or prompts.
- Do not treat process isolation as a security boundary. Enforce reviewer read-only behavior with restricted commands and preferably a read-only workspace/container.
- In current-tree mode, detect external workspace changes and pause before review.

## Testing

- Unit tests for state transitions, forbidden transitions, retry exhaustion, escalation, and restart recovery.
- Contract tests for `AgentProcess` using recorded Pi RPC JSONL streams.
- Integration tests for multi-chunk runs with a deterministic fake agent adapter.
- Opt-in end-to-end smoke test against local Pi RPC and a real configured model.

## Future evolution

The `AgentProcess` seam enables remote and distributed workers without changing the Workflow Engine. Future adapters may invoke Pi over SSH, containers, Kubernetes jobs, or a queue. Any parallel implementation must use isolated workspaces and explicit merge semantics.
