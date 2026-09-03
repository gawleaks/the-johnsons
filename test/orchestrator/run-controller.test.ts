import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createRunState, type Role, type RunState } from "../../src/domain/types.js";
import { ArtifactStore } from "../../src/storage/artifact-store.js";
import { defaultPolicy } from "../../src/policy/config.js";
import { RunController } from "../../src/orchestrator/run-controller.js";
import { createFakeAgent } from "../helpers/fake-agent.js";
import { ExternalWorkspaceChange } from "../../src/workspace/workspace-manager.js";

const tempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "johnsons-run-controller-"));

const withTempDir = async <T>(run: (workspace: string) => Promise<T>): Promise<T> => {
  const workspace = await tempDir();

  try {
    return await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

const runRoot = (workspace: string, runId: string): string => join(workspace, ".johnsons", "runs", runId);
const specPath = (workspace: string, runId: string): string => join(runRoot(workspace, runId), "specification.md");
const planPath = (workspace: string, runId: string): string => join(runRoot(workspace, runId), "plan.md");
const chunkDefinitionPath = (workspace: string, runId: string, chunkId: string): string =>
  join(runRoot(workspace, runId), "chunks", chunkId, "definition.md");
const implementationReportPath = (workspace: string, runId: string, chunkId: string): string =>
  join(runRoot(workspace, runId), "chunks", chunkId, "implementation-report.md");
const reviewPath = (workspace: string, runId: string, chunkId: string, attempt: number): string =>
  join(runRoot(workspace, runId), "chunks", chunkId, `review-${attempt}.md`);
const questionPath = (workspace: string, runId: string, index: number): string =>
  join(runRoot(workspace, runId), "questions", `${index.toString().padStart(4, "0")}.json`);
const statePath = (workspace: string, runId: string): string => join(runRoot(workspace, runId), "state.json");
const transitionsPath = (workspace: string, runId: string): string => join(runRoot(workspace, runId), "transitions.jsonl");

const joinHandoff = (...parts: ReadonlyArray<string>): string => parts.join("\n\n---\n\n");
const handoffDigest = (handoff: string): string => createHash("sha256").update(handoff).digest("hex");

const readTransitions = async (workspace: string, runId: string): Promise<ReadonlyArray<{ transition: Record<string, unknown>; next: RunState }>> =>
  (await readFile(transitionsPath(workspace, runId), "utf8"))
    .trimEnd()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { transition: Record<string, unknown>; next: RunState });

const expectLastDispatchTransition = async (
  workspace: string,
  role: Role,
  handoff: string,
  transitionTypes: ReadonlyArray<string>,
  transitionId: number,
): Promise<void> => {
  const transitions = await readTransitions(workspace, "run-1");
  const last = transitions.at(-1);

  expect(transitions.map(({ transition }) => transition.type)).toEqual(transitionTypes);
  expect(last?.transition).toEqual({ type: "dispatching", role, handoffDigest: handoffDigest(handoff) });
  expect(last?.transition).not.toHaveProperty("handoff");
  expect(last?.next.transitionId).toBe(transitionId);
  expect(JSON.parse(await readFile(statePath(workspace, "run-1"), "utf8"))).toMatchObject({ transitionId });
};

const planningState = (runId: string, workspace: string) => ({
  version: 1 as const,
  runId,
  workspace,
  phase: "planning" as const,
  chunks: [],
  transitionId: 2,
});

const executionState = (
  runId: string,
  workspace: string,
  phase: "developing" | "reviewing",
  reviewAttempts = 0,
) => ({
  version: 1 as const,
  runId,
  workspace,
  phase,
  chunks: [{ id: "chunk-a", status: phase, reviewAttempts }],
  activeChunkId: "chunk-a",
  transitionId: phase === "developing" ? 3 : 4,
});

const chunkDefinition = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  scope: `Implement ${id}`,
  nonGoals: ["skip extras"],
  prerequisites: ["approved spec"],
  touchedAreas: ["src/orchestrator/run-controller.ts"],
  acceptanceCriteria: [{ id: "AC-1", text: "planner preserves full definition" }],
  requiredChecks: ["npm test -- test/orchestrator/run-controller.test.ts"],
  handoffArtifacts: ["chunks/run-controller/definition.md"],
  recoveryNotes: ["re-run focused tests before retry"],
  ...overrides,
});

const planResponse = (...chunks: ReadonlyArray<Record<string, unknown>>) => JSON.stringify({ chunks });

const reviewerResponse = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  verdict: "approved",
  summary: "looks good",
  findings: [],
  acceptanceCriteria: [{ id: "AC-1", status: "pass" }],
  checks: [{ command: "npm test -- test/orchestrator/run-controller.test.ts", status: "pass", evidence: "ok" }],
  ...overrides,
});

const roleQuestionResponse = (question: string) => JSON.stringify({ question });

const createUi = (options: {
  approved?: boolean;
  onApproveSpecification?: ((specification: string) => void) | undefined;
  askQuestion?: ((role: "architect" | "planner" | "developer" | "reviewer", question: string) => Promise<string>) | undefined;
  resolveEscalation?: (() => Promise<boolean>) | undefined;
} = {}) => ({
  approveSpecification: async (specification: string) => {
    options.onApproveSpecification?.(specification);
    return options.approved ?? true;
  },
  askQuestion: options.askQuestion ?? (async () => "unused"),
  resolveEscalation: options.resolveEscalation ?? (async () => true),
});

const createController = async (
  workspace: string,
  response: string,
  approved: boolean,
  onApproveSpecification?: (specification: string) => void,
) => {
  const runId = "run-1";
  const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
  const agent = createFakeAgent({ architect: [response] });
  const ui = createUi({ approved, onApproveSpecification });

  return {
    agent,
    store,
    controller: new RunController({
      artifactStore: store,
      policy: defaultPolicy,
      roleAgent: agent,
      ui,
    }),
  };
};

const createWorkflowController = async (
  workspace: string,
  responses: Partial<Record<"architect" | "planner" | "developer" | "reviewer", ReadonlyArray<string>>>,
  ui = createUi(),
) => {
  const runId = "run-1";
  const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
  const agent = createFakeAgent(responses);
  const controller = new RunController({
    artifactStore: store,
    policy: defaultPolicy,
    roleAgent: agent,
    ui,
  });

  return { agent, controller, store };
};

const createPlanningController = async (
  workspace: string,
  specification: string,
  plannerResponse: string | ReadonlyArray<string>,
  responses: Partial<Record<"developer" | "reviewer", ReadonlyArray<string>>> = {},
  ui = createUi(),
) => {
  const runId = "run-1";
  const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
  await store.writeText("specification.md", specification);
  await store.writeJson("state.json", planningState(runId, workspace));
  const agent = createFakeAgent({ planner: Array.isArray(plannerResponse) ? plannerResponse : [plannerResponse], ...responses });
  const controller = new RunController({
    artifactStore: store,
    policy: defaultPolicy,
    roleAgent: agent,
    ui,
  });

  return { agent, controller, store };
};

const createExecutionController = async (
  workspace: string,
  state: RunState,
  responses: Partial<Record<"developer" | "reviewer", ReadonlyArray<string>>>,
  implementationReport?: string,
  ui = createUi(),
  workspaceSafety?: { capture(workspace: string): Promise<unknown>; assertUnchanged(snapshot: unknown, workspace: string): Promise<void> },
) => {
  const runId = "run-1";
  const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
  await Promise.all([
    store.writeText("specification.md", "# Spec\n"),
    store.writeText("plan.md", planResponse(chunkDefinition("chunk-a"))),
    store.writeText("chunks/chunk-a/definition.md", JSON.stringify(chunkDefinition("chunk-a"))),
    store.writeJson("state.json", state),
    ...(implementationReport === undefined
      ? []
      : [store.writeText(`chunks/chunk-a/implementation-report.md`, implementationReport)]),
  ]);
  const agent = createFakeAgent(responses);
  const controller = new RunController({
    artifactStore: store,
    policy: defaultPolicy,
    roleAgent: agent,
    ui,
    ...(workspaceSafety === undefined ? {} : { workspaceSafety }),
  });

  return { agent, controller, store };
};

const createQuestionRetryUi = (
  workspace: string,
  role: Role,
  question: string,
  answer: string,
  approved = true,
  onApproveSpecification?: (specification: string) => void,
) => createUi({
  approved,
  onApproveSpecification,
  askQuestion: async (askedRole, askedQuestion) => {
    expect(askedRole).toBe(role);
    expect(askedQuestion).toBe(question);
    await expect(readFile(questionPath(workspace, "run-1", 1), "utf8")).resolves.toBe(
      JSON.stringify({ role, question }),
    );
    return answer;
  },
});

describe("RunController slice 1", () => {
  it("runs from architect approval through planning and reviewed execution to completion", async () => {
    await withTempDir(async (workspace) => {
      let approvedSpecification = "";
      const specification = "# Spec\n";
      const plannerOutput = planResponse(chunkDefinition("chunk-a"));
      const { agent, controller, store } = await createWorkflowController(
        workspace,
        {
          architect: [JSON.stringify({ specification })],
          planner: [plannerOutput],
          developer: [JSON.stringify({ report: "implemented", deviated: false })],
          reviewer: [reviewerResponse()],
        },
        createUi({
          approved: true,
          onApproveSpecification: (value) => {
            approvedSpecification = value;
          },
        }),
      );

      await controller.start();

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "completed",
        transitionId: 9,
        chunks: [{ id: "chunk-a", status: "approved", reviewAttempts: 0 }],
      });
      await expect(readFile(specPath(workspace, "run-1"), "utf8")).resolves.toBe(specification);
      await expect(readFile(planPath(workspace, "run-1"), "utf8")).resolves.toBe(plannerOutput);
      await expect(readFile(implementationReportPath(workspace, "run-1", "chunk-a"), "utf8")).resolves.toBe("implemented");
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 1), "utf8")).resolves.toBe(reviewerResponse());
      expect(approvedSpecification).toBe(specification);
      expect(agent.calls.map(({ role }) => role)).toEqual(["architect", "planner", "developer", "reviewer"]);
    });
  });

  it("stops at awaiting spec approval when the UI rejects", async () => {
    await withTempDir(async (workspace) => {
      const { agent, controller, store } = await createController(
        workspace,
        JSON.stringify({ specification: "# Spec\n" }),
        false,
      );

      await controller.start();

      await expect(store.loadState()).resolves.toMatchObject({ phase: "awaiting-spec-approval", transitionId: 2 });
      expect(agent.calls).toHaveLength(1);
      expect(agent.calls[0]?.role).toBe("architect");
    });
  });

  it.each([
    ["malformed architect output", "not json"],
    ["empty specification", JSON.stringify({ specification: "" })],
  ])("rejects %s without transitioning", async (_label, response) => {
    await withTempDir(async (workspace) => {
      const runId = "run-1";
      const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
      const agent = createFakeAgent({ architect: [response] });
      const controller = new RunController({
        artifactStore: store,
        policy: defaultPolicy,
        roleAgent: agent,
        ui: createUi(),
      });

      await expect(controller.start()).rejects.toThrow();
      await expect(store.loadState()).resolves.toMatchObject({ phase: "architecting", transitionId: 1 });
      expect(agent.calls.map(({ role }) => role)).toEqual(["architect"]);
      await expect(readFile(specPath(workspace, runId), "utf8")).rejects.toThrow();
    });
  });

  it("stops after a rejected architect specification and does not dispatch planner", async () => {
    await withTempDir(async (workspace) => {
      const { agent, controller } = await createController(
        workspace,
        JSON.stringify({ specification: "# Spec\n" }),
        false,
      );

      await controller.start();

      expect(agent.calls.map(({ role }) => role)).toEqual(["architect"]);
    });
  });
});

describe("RunController slice 2", () => {
  it("writes the full plan and full chunk definitions before completing the planned chunks", async () => {
    await withTempDir(async (workspace) => {
      const specification = "# Spec\n";
      const plannerResponse = planResponse(
        chunkDefinition("chunk-a"),
        chunkDefinition("chunk-b", {
          acceptanceCriteria: [{ id: "AC-2", text: "second chunk keeps its own criteria" }],
        }),
      );
      const { agent, controller, store } = await createPlanningController(
        workspace,
        specification,
        plannerResponse,
        {
          developer: [
            JSON.stringify({ report: "implemented a", deviated: false }),
            JSON.stringify({ report: "implemented b", deviated: false }),
          ],
          reviewer: [
            reviewerResponse(),
            reviewerResponse({
              summary: "chunk b approved",
              acceptanceCriteria: [{ id: "AC-2", status: "pass" }],
            }),
          ],
        },
      );

      await controller.start();

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "completed",
        transitionId: 12,
        chunks: [
          { id: "chunk-a", status: "approved", reviewAttempts: 0 },
          { id: "chunk-b", status: "approved", reviewAttempts: 0 },
        ],
      });
      await expect(readFile(planPath(workspace, "run-1"), "utf8")).resolves.toBe(plannerResponse);
      await expect(readFile(chunkDefinitionPath(workspace, "run-1", "chunk-a"), "utf8")).resolves.toBe(
        JSON.stringify(chunkDefinition("chunk-a")),
      );
      await expect(readFile(chunkDefinitionPath(workspace, "run-1", "chunk-b"), "utf8")).resolves.toBe(
        JSON.stringify(
          chunkDefinition("chunk-b", {
            acceptanceCriteria: [{ id: "AC-2", text: "second chunk keeps its own criteria" }],
          }),
        ),
      );
      expect(agent.calls.map(({ role }) => role)).toEqual(["planner", "developer", "reviewer", "developer", "reviewer"]);
    });
  });

  it.each([
    ["malformed JSON", "not json"],
    ["empty chunks", JSON.stringify({ chunks: [] })],
    ["non-object chunk entry", JSON.stringify({ chunks: ["chunk-a"] })],
    ["duplicate chunk ids", planResponse(chunkDefinition("chunk-a"), chunkDefinition("chunk-a"))],
    ["path-escaping chunk ids", planResponse(chunkDefinition("../evil"))],
    ["slash chunk ids", planResponse(chunkDefinition("a/b"))],
    ["backslash chunk ids", planResponse(chunkDefinition("a\\b"))],
    ["dot chunk ids", planResponse(chunkDefinition("."))],
    ["dotdot chunk ids", planResponse(chunkDefinition(".."))],
    ["empty chunk id", planResponse(chunkDefinition(""))],
    ["missing scope", planResponse(chunkDefinition("chunk-a", { scope: undefined }))],
    ["empty scope", planResponse(chunkDefinition("chunk-a", { scope: "" }))],
    ["missing nonGoals", planResponse(chunkDefinition("chunk-a", { nonGoals: undefined }))],
    ["empty nonGoals entry", planResponse(chunkDefinition("chunk-a", { nonGoals: [""] }))],
    ["missing prerequisites", planResponse(chunkDefinition("chunk-a", { prerequisites: undefined }))],
    ["empty prerequisites entry", planResponse(chunkDefinition("chunk-a", { prerequisites: [""] }))],
    ["missing touchedAreas", planResponse(chunkDefinition("chunk-a", { touchedAreas: undefined }))],
    ["empty touchedAreas entry", planResponse(chunkDefinition("chunk-a", { touchedAreas: [""] }))],
    ["missing acceptanceCriteria", planResponse(chunkDefinition("chunk-a", { acceptanceCriteria: undefined }))],
    ["empty acceptanceCriteria", planResponse(chunkDefinition("chunk-a", { acceptanceCriteria: [] }))],
    ["missing acceptanceCriteria id", planResponse(chunkDefinition("chunk-a", { acceptanceCriteria: [{ text: "x" }] }))],
    ["empty acceptanceCriteria id", planResponse(chunkDefinition("chunk-a", { acceptanceCriteria: [{ id: "", text: "x" }] }))],
    ["missing acceptanceCriteria text", planResponse(chunkDefinition("chunk-a", { acceptanceCriteria: [{ id: "AC-1" }] }))],
    ["empty acceptanceCriteria text", planResponse(chunkDefinition("chunk-a", { acceptanceCriteria: [{ id: "AC-1", text: "" }] }))],
    ["missing requiredChecks", planResponse(chunkDefinition("chunk-a", { requiredChecks: undefined }))],
    ["empty requiredChecks entry", planResponse(chunkDefinition("chunk-a", { requiredChecks: [""] }))],
    ["missing handoffArtifacts", planResponse(chunkDefinition("chunk-a", { handoffArtifacts: undefined }))],
    ["empty handoffArtifacts entry", planResponse(chunkDefinition("chunk-a", { handoffArtifacts: [""] }))],
    ["missing recoveryNotes", planResponse(chunkDefinition("chunk-a", { recoveryNotes: undefined }))],
    ["empty recoveryNotes entry", planResponse(chunkDefinition("chunk-a", { recoveryNotes: [""] }))],
    ["extra chunk fields", planResponse(chunkDefinition("chunk-a", { extra: true }))],
  ])("rejects %s before plan artifacts or transitions", async (_label, plannerResponse) => {
    await withTempDir(async (workspace) => {
      const { agent, controller, store } = await createPlanningController(
        workspace,
        "# Spec\n",
        plannerResponse,
      );

      await expect(controller.start()).rejects.toThrow();
      await expect(store.loadState()).resolves.toMatchObject({ phase: "planning", transitionId: 3 });
      expect(agent.calls.map(({ role }) => role)).toEqual(["planner"]);
      await expect(readFile(planPath(workspace, "run-1"), "utf8")).rejects.toThrow();
      await expect(readFile(chunkDefinitionPath(workspace, "run-1", "chunk-a"), "utf8")).rejects.toThrow();
    });
  });

  it("sends the exact specification handoff to the planner", async () => {
    await withTempDir(async (workspace) => {
      const specification = "# Spec\n\n- one\n";
      const plannerResponse = planResponse(chunkDefinition("chunk-a"));
      const { agent, controller } = await createPlanningController(
        workspace,
        specification,
        plannerResponse,
        {
          developer: [JSON.stringify({ report: "implemented", deviated: false })],
          reviewer: [reviewerResponse()],
        },
      );

      await controller.start();

      expect(agent.calls[0]).toEqual({ role: "planner", handoff: specification });
    });
  });

  it("resumes from durable planning by reusing the stored specification and moving to developing", async () => {
    await withTempDir(async (workspace) => {
      const specification = "# Existing spec\n\n- durable\n";
      const plannerResponse = planResponse(chunkDefinition("chunk-a"));
      const { agent, controller, store } = await createPlanningController(
        workspace,
        specification,
        plannerResponse,
      );

      await expect(controller.resume()).rejects.toThrow("No fake response for developer");

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "developing",
        transitionId: 5,
        activeChunkId: "chunk-a",
        chunks: [{ id: "chunk-a", status: "developing", reviewAttempts: 0 }],
      });
      await expect(readFile(specPath(workspace, "run-1"), "utf8")).resolves.toBe(specification);
      await expect(readFile(planPath(workspace, "run-1"), "utf8")).resolves.toBe(plannerResponse);
      await expect(readFile(chunkDefinitionPath(workspace, "run-1", "chunk-a"), "utf8")).resolves.toBe(
        JSON.stringify(chunkDefinition("chunk-a")),
      );
      expect(agent.calls.map(({ role }) => role)).toEqual(["planner", "developer"]);
      expect(agent.calls[0]).toEqual({ role: "planner", handoff: specification });
    });
  });
});

describe("RunController slice 3", () => {
  it("completes an approved single chunk and persists implementation and review reports", async () => {
    await withTempDir(async (workspace) => {
      const { agent, controller, store } = await createExecutionController(
        workspace,
        executionState("run-1", workspace, "developing"),
        {
          developer: [JSON.stringify({ report: "implemented", deviated: false })],
          reviewer: [reviewerResponse()],
        },
      );

      await controller.start();

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "completed",
        transitionId: 7,
        chunks: [{ id: "chunk-a", status: "approved", reviewAttempts: 0 }],
      });
      await expect(readFile(implementationReportPath(workspace, "run-1", "chunk-a"), "utf8")).resolves.toBe("implemented");
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 1), "utf8")).resolves.toBe(reviewerResponse());
      expect(agent.calls).toEqual([
        {
          role: "developer",
          handoff: ["# Spec\n", planResponse(chunkDefinition("chunk-a")), JSON.stringify(chunkDefinition("chunk-a"))].join("\n\n---\n\n"),
        },
        {
          role: "reviewer",
          handoff: ["# Spec\n", planResponse(chunkDefinition("chunk-a")), JSON.stringify(chunkDefinition("chunk-a")), "implemented"].join("\n\n---\n\n"),
        },
      ]);
    });
  });

  it("retries the same chunk after rejection and increments the review attempt", async () => {
    await withTempDir(async (workspace) => {
      const { agent, controller, store } = await createExecutionController(
        workspace,
        executionState("run-1", workspace, "developing"),
        {
          developer: [
            JSON.stringify({ report: "implemented once", deviated: false }),
            JSON.stringify({ report: "implemented twice", deviated: false }),
          ],
          reviewer: [
            reviewerResponse({
              verdict: "rejected",
              summary: "try again",
              findings: [{ severity: "major", location: "src/file.ts:1", problem: "broken", requiredFix: "fix it" }],
              acceptanceCriteria: [{ id: "AC-1", status: "fail" }],
              checks: [{ command: "npm test -- test/orchestrator/run-controller.test.ts", status: "fail", evidence: "failed" }],
            }),
            reviewerResponse({ summary: "now good" }),
          ],
        },
      );

      await controller.start();

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "completed",
        transitionId: 11,
        chunks: [{ id: "chunk-a", status: "approved", reviewAttempts: 1 }],
      });
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 1), "utf8")).resolves.toBe(
        reviewerResponse({
          verdict: "rejected",
          summary: "try again",
          findings: [{ severity: "major", location: "src/file.ts:1", problem: "broken", requiredFix: "fix it" }],
          acceptanceCriteria: [{ id: "AC-1", status: "fail" }],
          checks: [{ command: "npm test -- test/orchestrator/run-controller.test.ts", status: "fail", evidence: "failed" }],
        }),
      );
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 2), "utf8")).resolves.toBe(reviewerResponse({ summary: "now good" }));
      await expect(readFile(implementationReportPath(workspace, "run-1", "chunk-a"), "utf8")).resolves.toBe("implemented twice");
      expect(agent.calls.map(({ role }) => role)).toEqual(["developer", "reviewer", "developer", "reviewer"]);
    });
  });

  it("escalates when rejection reaches the retry limit", async () => {
    await withTempDir(async (workspace) => {
      const { agent, controller, store } = await createExecutionController(
        workspace,
        executionState("run-1", workspace, "developing", 1),
        {
          developer: [JSON.stringify({ report: "implemented", deviated: false })],
          reviewer: [reviewerResponse({
            verdict: "rejected",
            summary: "still broken",
            findings: [{ severity: "major", location: "src/file.ts:1", problem: "broken", requiredFix: "fix it" }],
            acceptanceCriteria: [{ id: "AC-1", status: "fail" }],
            checks: [{ command: "npm test -- test/orchestrator/run-controller.test.ts", status: "fail", evidence: "failed" }],
          })],
        },
      );

      await controller.start();

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "escalated",
        activeChunkId: "chunk-a",
        transitionId: 7,
        chunks: [{ id: "chunk-a", status: "escalated", reviewAttempts: 2 }],
      });
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 2), "utf8")).resolves.toBe(reviewerResponse({
        verdict: "rejected",
        summary: "still broken",
        findings: [{ severity: "major", location: "src/file.ts:1", problem: "broken", requiredFix: "fix it" }],
        acceptanceCriteria: [{ id: "AC-1", status: "fail" }],
        checks: [{ command: "npm test -- test/orchestrator/run-controller.test.ts", status: "fail", evidence: "failed" }],
      }));
      expect(agent.calls.map(({ role }) => role)).toEqual(["developer", "reviewer"]);
    });
  });

  it("escalates developer deviation without calling reviewer", async () => {
    await withTempDir(async (workspace) => {
      const { agent, controller, store } = await createExecutionController(
        workspace,
        executionState("run-1", workspace, "developing"),
        { developer: [JSON.stringify({ report: "need help", deviated: true })] },
      );

      await controller.start();

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "escalated",
        activeChunkId: "chunk-a",
        transitionId: 5,
        chunks: [{ id: "chunk-a", status: "escalated", reviewAttempts: 0 }],
      });
      await expect(readFile(implementationReportPath(workspace, "run-1", "chunk-a"), "utf8")).resolves.toBe("need help");
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 1), "utf8")).rejects.toThrow();
      expect(agent.calls.map(({ role }) => role)).toEqual(["developer"]);
    });
  });

  it("allows escalate reviewer verdicts that match the schema", async () => {
    await withTempDir(async (workspace) => {
      const { controller, store } = await createExecutionController(
        workspace,
        executionState("run-1", workspace, "reviewing"),
        {
          reviewer: [reviewerResponse({
            verdict: "escalate",
            summary: "need a human",
            findings: [{ severity: "minor", location: "src/file.ts:1", problem: "unclear", requiredFix: "decide" }],
            acceptanceCriteria: [{ id: "AC-1", status: "fail" }],
            checks: [{ command: "npm test -- test/orchestrator/run-controller.test.ts", status: "fail", evidence: "blocked" }],
          })],
        },
        "implemented",
      );

      await controller.start();

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "escalated",
        activeChunkId: "chunk-a",
        transitionId: 6,
        chunks: [{ id: "chunk-a", status: "escalated", reviewAttempts: 0 }],
      });
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 1), "utf8")).resolves.toBe(reviewerResponse({
        verdict: "escalate",
        summary: "need a human",
        findings: [{ severity: "minor", location: "src/file.ts:1", problem: "unclear", requiredFix: "decide" }],
        acceptanceCriteria: [{ id: "AC-1", status: "fail" }],
        checks: [{ command: "npm test -- test/orchestrator/run-controller.test.ts", status: "fail", evidence: "blocked" }],
      }));
    });
  });

  it.each([
    ["not json", "Invalid developer output"],
    [JSON.stringify({ report: "", deviated: false }), "Invalid developer output"],
  ])("rejects malformed developer responses without artifacts or transitions", async (response) => {
    await withTempDir(async (workspace) => {
      const initialState = executionState("run-1", workspace, "developing");
      const { controller, store } = await createExecutionController(
        workspace,
        initialState,
        { developer: [response] },
      );

      await expect(controller.start()).rejects.toThrow("Invalid developer output");
      await expect(store.loadState()).resolves.toEqual({ ...initialState, transitionId: initialState.transitionId + 1 });
      await expect(readFile(implementationReportPath(workspace, "run-1", "chunk-a"), "utf8")).rejects.toThrow();
    });
  });

  it("reviews normally when metadata workspace is unchanged", async () => {
    await withTempDir(async (workspace) => {
      const { agent, controller } = await createExecutionController(
        workspace,
        executionState("run-1", workspace, "developing"),
        {
          developer: [JSON.stringify({ report: "implemented", deviated: false })],
          reviewer: [reviewerResponse()],
        },
        undefined,
        createUi(),
        {
          capture: async () => ({ before: "snapshot" }),
          assertUnchanged: async () => undefined,
        },
      );

      await expect(controller.start()).resolves.toMatchObject({ phase: "completed" });
      expect(agent.calls.map(({ role }) => role)).toEqual(["developer", "reviewer"]);
    });
  });

  it("reloads a persisted snapshot after restart before reviewer dispatch", async () => {
    await withTempDir(async (workspace) => {
      const state = executionState("run-1", workspace, "reviewing");
      const { agent, controller, store } = await createExecutionController(
        workspace,
        state,
        { reviewer: [reviewerResponse()] },
        "implemented",
        createUi(),
        {
          capture: async () => ({ ignored: true }),
          assertUnchanged: async () => { throw new ExternalWorkspaceChange(workspace); },
        },
      );
      await store.writeJson("chunks/chunk-a/workspace-snapshot.json", { before: "developer" });

      await expect(controller.resume()).resolves.toMatchObject({ phase: "escalated" });
      expect(agent.calls).toEqual([]);
    });
  });

  it("escalates without reviewer dispatch when metadata workspace changes", async () => {
    await withTempDir(async (workspace) => {
      const state = executionState("run-1", workspace, "developing");
      const { agent, controller, store } = await createExecutionController(
        workspace,
        state,
        { developer: [JSON.stringify({ report: "implemented", deviated: false })] },
        undefined,
        createUi(),
        {
          capture: async () => ({ before: "snapshot" }),
          assertUnchanged: async () => { throw new ExternalWorkspaceChange(workspace); },
        },
      );

      await expect(controller.start()).resolves.toMatchObject({ phase: "escalated" });
      expect(agent.calls.map(({ role }) => role)).toEqual(["developer"]);
      await expect(store.loadState()).resolves.toMatchObject({ phase: "escalated" });
    });
  });

  it.each([
    ["not json", "Invalid reviewer output"],
    [reviewerResponse({ summary: "" }), "Invalid reviewer output"],
    [reviewerResponse({ findings: [{ severity: "blocker", location: "src/file.ts:1", problem: "broken", requiredFix: "fix it" }] }), "Invalid reviewer output"],
    [reviewerResponse({ findings: [{ severity: "major", location: "src/file.ts:1", problem: "broken", requiredFix: "fix it" }] }), "Invalid reviewer output"],
    [reviewerResponse({ acceptanceCriteria: [] }), "Invalid reviewer output"],
    [reviewerResponse({ acceptanceCriteria: [{ id: "AC-2", status: "pass" }] }), "Invalid reviewer output"],
    [reviewerResponse({ acceptanceCriteria: [{ id: "AC-1", status: "pass" }, { id: "AC-1", status: "pass" }] }), "Invalid reviewer output"],
    [reviewerResponse({ checks: [] }), "Invalid reviewer output"],
    [reviewerResponse({ checks: [{ command: "npm test", status: "pass", evidence: "ok" }] }), "Invalid reviewer output"],
    [reviewerResponse({ checks: [{ command: "npm test -- test/orchestrator/run-controller.test.ts", status: "pass", evidence: "ok" }, { command: "npm test -- test/orchestrator/run-controller.test.ts", status: "pass", evidence: "ok again" }] }), "Invalid reviewer output"],
  ])("rejects malformed reviewer responses without artifacts or transitions", async (response) => {
    await withTempDir(async (workspace) => {
      const initialState = executionState("run-1", workspace, "reviewing");
      const { controller, store } = await createExecutionController(
        workspace,
        initialState,
        { reviewer: [response] },
        "implemented",
      );

      await expect(controller.start()).rejects.toThrow("Invalid reviewer output");
      await expect(store.loadState()).resolves.toEqual({ ...initialState, transitionId: initialState.transitionId + 1 });
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 1), "utf8")).rejects.toThrow();
    });
  });
});

describe("RunController slice 4", () => {
  it("resumes a rejected specification by re-asking approval on the stored spec and completing without re-running architect", async () => {
    await withTempDir(async (workspace) => {
      const runId = "run-1";
      const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
      const specification = "# Existing spec\n";
      await store.writeText("specification.md", specification);
      await store.writeJson("state.json", {
        ...createRunState(runId, workspace),
        phase: "awaiting-spec-approval",
        transitionId: 1,
      });
      let approvedSpecification = "";
      const agent = createFakeAgent({
        planner: [planResponse(chunkDefinition("chunk-a"))],
        developer: [JSON.stringify({ report: "implemented", deviated: false })],
        reviewer: [reviewerResponse({ summary: "approved after resume" })],
      });
      const controller = new RunController({
        artifactStore: store,
        policy: defaultPolicy,
        roleAgent: agent,
        ui: createUi({
          approved: true,
          onApproveSpecification: (value) => {
            approvedSpecification = value;
          },
        }),
      });

      await controller.resume();

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "completed",
        transitionId: 8,
        chunks: [{ id: "chunk-a", status: "approved", reviewAttempts: 0 }],
      });
      expect(approvedSpecification).toBe(specification);
      expect(agent.calls.map(({ role }) => role)).toEqual(["planner", "developer", "reviewer"]);
    });
  });

  it("keeps awaiting approval when a resumed specification is rejected again", async () => {
    await withTempDir(async (workspace) => {
      const runId = "run-1";
      const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
      const specification = "# Existing spec\n";
      await store.writeText("specification.md", specification);
      await store.writeJson("state.json", {
        ...createRunState(runId, workspace),
        phase: "awaiting-spec-approval",
        transitionId: 1,
      });
      let approvedSpecification = "";
      const agent = createFakeAgent({ planner: [planResponse(chunkDefinition("chunk-a"))] });
      const controller = new RunController({
        artifactStore: store,
        policy: defaultPolicy,
        roleAgent: agent,
        ui: createUi({
          approved: false,
          onApproveSpecification: (value) => {
            approvedSpecification = value;
          },
        }),
      });

      await controller.resume();

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "awaiting-spec-approval",
        transitionId: 1,
      });
      expect(approvedSpecification).toBe(specification);
      expect(agent.calls).toEqual([]);
    });
  });

  it("resumes from developing by dispatching only developer and reviewer and preserving prior artifacts", async () => {
    await withTempDir(async (workspace) => {
      const { store } = await createExecutionController(
        workspace,
        executionState("run-1", workspace, "developing"),
        {},
      );
      await store.writeText("specification.md", "# Existing spec\n");
      const agent = createFakeAgent({
        developer: [JSON.stringify({ report: "implemented", deviated: false })],
        reviewer: [reviewerResponse({ summary: "approved" })],
      });
      const controller = new RunController({
        artifactStore: store,
        policy: defaultPolicy,
        roleAgent: agent,
        ui: createUi(),
      });

      await controller.resume();

      await expect(store.loadState()).resolves.toMatchObject({ phase: "completed" });
      await expect(readFile(specPath(workspace, "run-1"), "utf8")).resolves.toBe("# Existing spec\n");
      await expect(readFile(planPath(workspace, "run-1"), "utf8")).resolves.toBe(planResponse(chunkDefinition("chunk-a")));
      expect(agent.calls.map(({ role }) => role)).toEqual(["developer", "reviewer"]);
    });
  });

  it("persists user questions with durable numbering across controller instances", async () => {
    await withTempDir(async (workspace) => {
      const runId = "run-1";
      const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
      const first = new RunController({
        artifactStore: store,
        policy: defaultPolicy,
        roleAgent: createFakeAgent(),
        ui: createUi({ askQuestion: async () => "first answer" }),
      });

      await expect(first.answerUserQuestion("developer", "What now?")).resolves.toBe("first answer");
      await expect(readFile(questionPath(workspace, runId, 1), "utf8")).resolves.toBe(
        JSON.stringify({ role: "developer", question: "What now?", answer: "first answer" }),
      );

      const second = new RunController({
        artifactStore: store,
        policy: defaultPolicy,
        roleAgent: createFakeAgent(),
        ui: createUi({ askQuestion: async () => "second answer" }),
      });

      await expect(second.answerUserQuestion("reviewer", "Anything else?")).resolves.toBe("second answer");
      await expect(readFile(questionPath(workspace, runId, 2), "utf8")).resolves.toBe(
        JSON.stringify({ role: "reviewer", question: "Anything else?", answer: "second answer" }),
      );
    });
  });

  it("stops escalated resume when the user declines resolution", async () => {
    await withTempDir(async (workspace) => {
      const state = {
        ...executionState("run-1", workspace, "developing"),
        phase: "escalated" as const,
        chunks: [{ id: "chunk-a", status: "escalated" as const, reviewAttempts: 1 }],
        transitionId: 5,
      };
      const { store } = await createExecutionController(workspace, state, {});
      const agent = createFakeAgent();
      const controller = new RunController({
        artifactStore: store,
        policy: defaultPolicy,
        roleAgent: agent,
        ui: createUi({ resolveEscalation: async () => false }),
      });

      await controller.resume();

      await expect(store.loadState()).resolves.toMatchObject({ phase: "failed", transitionId: 6 });
      expect(agent.calls).toEqual([]);
    });
  });

  it("resumes escalated work when the user resolves it and can complete", async () => {
    await withTempDir(async (workspace) => {
      const state = {
        ...executionState("run-1", workspace, "developing"),
        phase: "escalated" as const,
        chunks: [{ id: "chunk-a", status: "escalated" as const, reviewAttempts: 1 }],
        transitionId: 5,
      };
      const { store } = await createExecutionController(workspace, state, {});
      const agent = createFakeAgent({
        developer: [JSON.stringify({ report: "fixed", deviated: false })],
        reviewer: [reviewerResponse({ summary: "done" })],
      });
      const controller = new RunController({
        artifactStore: store,
        policy: defaultPolicy,
        roleAgent: agent,
        ui: createUi({ resolveEscalation: async () => true }),
      });

      await controller.resume();

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "completed",
        transitionId: 10,
        chunks: [{ id: "chunk-a", status: "approved", reviewAttempts: 1 }],
      });
      expect(agent.calls.map(({ role }) => role)).toEqual(["developer", "reviewer"]);
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 2), "utf8")).resolves.toBe(reviewerResponse({ summary: "done" }));
    });
  });
});

describe("RunController slice 5", () => {
  it.each(["architect", "planner", "developer", "reviewer"] as const)("persists a dispatching transition with role and handoff digest before the %s prompt", async (role) => {
    await withTempDir(async (workspace) => {
      const runId = "run-1";

      if (role === "architect") {
        const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
        const controller = new RunController({
          artifactStore: store,
          policy: defaultPolicy,
          roleAgent: {
            prompt: async (askedRole, handoff) => {
              expect(askedRole).toBe("architect");
              expect(handoff).toBe("");
              await expectLastDispatchTransition(workspace, "architect", "", ["dispatching"], 1);
              return JSON.stringify({ specification: "# Spec\n" });
            },
          },
          ui: createUi({ approved: false }),
        });

        await controller.start();
        return;
      }

      if (role === "planner") {
        const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
        await store.writeText("specification.md", "# Spec\n");
        await store.writeJson("state.json", planningState(runId, workspace));
        const controller = new RunController({
          artifactStore: store,
          policy: defaultPolicy,
          roleAgent: {
            prompt: async (askedRole, handoff) => {
              if (askedRole !== "planner") {
                throw new Error("stop after planner");
              }

              expect(handoff).toBe("# Spec\n");
              await expectLastDispatchTransition(workspace, "planner", "# Spec\n", ["dispatching"], 3);
              return planResponse(chunkDefinition("chunk-a"));
            },
          },
          ui: createUi(),
        });

        await expect(controller.start()).rejects.toThrow("stop after planner");
        return;
      }

      if (role === "developer") {
        const controllerState = executionState(runId, workspace, "developing");
        const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
        const handoff = joinHandoff("# Spec\n", planResponse(chunkDefinition("chunk-a")), JSON.stringify(chunkDefinition("chunk-a")));
        await Promise.all([
          store.writeText("specification.md", "# Spec\n"),
          store.writeText("plan.md", planResponse(chunkDefinition("chunk-a"))),
          store.writeText("chunks/chunk-a/definition.md", JSON.stringify(chunkDefinition("chunk-a"))),
          store.writeJson("state.json", controllerState),
        ]);
        const controller = new RunController({
          artifactStore: store,
          policy: defaultPolicy,
          roleAgent: {
            prompt: async (askedRole, promptHandoff) => {
              if (askedRole !== "developer") {
                throw new Error("stop after developer");
              }

              expect(promptHandoff).toBe(handoff);
              await expectLastDispatchTransition(workspace, "developer", handoff, ["dispatching"], 4);
              return JSON.stringify({ report: "implemented", deviated: false });
            },
          },
          ui: createUi(),
        });

        await expect(controller.start()).rejects.toThrow("stop after developer");
        return;
      }

      const controllerState = executionState(runId, workspace, "reviewing");
      const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
      const review = "implemented";
      const handoff = joinHandoff("# Spec\n", planResponse(chunkDefinition("chunk-a")), JSON.stringify(chunkDefinition("chunk-a")), review);
      await Promise.all([
        store.writeText("specification.md", "# Spec\n"),
        store.writeText("plan.md", planResponse(chunkDefinition("chunk-a"))),
        store.writeText("chunks/chunk-a/definition.md", JSON.stringify(chunkDefinition("chunk-a"))),
        store.writeText("chunks/chunk-a/implementation-report.md", review),
        store.writeJson("state.json", controllerState),
      ]);
      const controller = new RunController({
        artifactStore: store,
        policy: defaultPolicy,
        roleAgent: {
          prompt: async (askedRole, promptHandoff) => {
            expect(askedRole).toBe("reviewer");
            expect(promptHandoff).toBe(handoff);
            await expectLastDispatchTransition(workspace, "reviewer", handoff, ["dispatching"], 5);
            return reviewerResponse();
          },
        },
        ui: createUi(),
      });

      await controller.start();
    });
  });

  it.each([
    ["architect", "What scope?", "focus the spec", 1, JSON.stringify({ specification: "# Spec\n" }), "", "focus the spec"],
    ["planner", "Which chunks?", "one chunk", 3, planResponse(chunkDefinition("chunk-a")), "# Spec\n", joinHandoff("# Spec\n", "one chunk")],
    [
      "developer",
      "What implementation detail?",
      "keep it small",
      4,
      JSON.stringify({ report: "implemented", deviated: false }),
      joinHandoff("# Spec\n", planResponse(chunkDefinition("chunk-a")), JSON.stringify(chunkDefinition("chunk-a"))),
      joinHandoff("# Spec\n", planResponse(chunkDefinition("chunk-a")), JSON.stringify(chunkDefinition("chunk-a")), "keep it small"),
    ],
    [
      "reviewer",
      "Anything unclear?",
      "all clear",
      5,
      reviewerResponse(),
      joinHandoff("# Spec\n", planResponse(chunkDefinition("chunk-a")), JSON.stringify(chunkDefinition("chunk-a")), "implemented"),
      joinHandoff("# Spec\n", planResponse(chunkDefinition("chunk-a")), JSON.stringify(chunkDefinition("chunk-a")), "implemented", "all clear"),
    ],
  ] as const)("persists dispatching transitions before %s retry prompts", async (role, question, answer, firstDispatchId, finalResponse, initialHandoff, retryHandoff) => {
    await withTempDir(async (workspace) => {
      const runId = "run-1";
      let promptCount = 0;
      const roleAgent = {
        prompt: async (askedRole: Role, handoff: string): Promise<string> => {
          if (askedRole !== role) {
            throw new Error(`stop after ${role}`);
          }

          promptCount += 1;
          const expectedHandoff = promptCount === 1 ? initialHandoff : retryHandoff;
          const expectedTransitionTypes = promptCount === 1
            ? ["dispatching"]
            : ["dispatching", "question-asked", "question-answered", "dispatching"];
          const expectedTransitionId = promptCount === 1 ? firstDispatchId : firstDispatchId + 3;

          expect(handoff).toBe(expectedHandoff);
          await expectLastDispatchTransition(workspace, role, expectedHandoff, expectedTransitionTypes, expectedTransitionId);
          return promptCount === 1 ? roleQuestionResponse(question) : finalResponse;
        },
      };
      const ui = createUi({
        approved: role === "architect" ? false : true,
        askQuestion: async (askedRole, askedQuestion) => {
          expect(askedRole).toBe(role);
          expect(askedQuestion).toBe(question);
          await expect(readFile(questionPath(workspace, runId, 1), "utf8")).resolves.toBe(JSON.stringify({ role, question }));
          return answer;
        },
      });

      if (role === "architect") {
        const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
        const controller = new RunController({ artifactStore: store, policy: defaultPolicy, roleAgent, ui });

        await controller.start();
        expect(promptCount).toBe(2);
        return;
      }

      if (role === "planner") {
        const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
        await store.writeText("specification.md", "# Spec\n");
        await store.writeJson("state.json", planningState(runId, workspace));
        const controller = new RunController({ artifactStore: store, policy: defaultPolicy, roleAgent, ui });

        await expect(controller.start()).rejects.toThrow("stop after planner");
        expect(promptCount).toBe(2);
        return;
      }

      if (role === "developer") {
        const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
        await Promise.all([
          store.writeText("specification.md", "# Spec\n"),
          store.writeText("plan.md", planResponse(chunkDefinition("chunk-a"))),
          store.writeText("chunks/chunk-a/definition.md", JSON.stringify(chunkDefinition("chunk-a"))),
          store.writeJson("state.json", executionState(runId, workspace, "developing")),
        ]);
        const controller = new RunController({ artifactStore: store, policy: defaultPolicy, roleAgent, ui });

        await expect(controller.start()).rejects.toThrow("stop after developer");
        expect(promptCount).toBe(2);
        return;
      }

      const { store } = await createExecutionController(
        workspace,
        executionState(runId, workspace, "reviewing"),
        {},
        "implemented",
        ui,
      );
      const controller = new RunController({ artifactStore: store, policy: defaultPolicy, roleAgent, ui });

      await controller.start();
      expect(promptCount).toBe(2);
    });
  });

  it("resumes from a durable pending developer question without dispatching before the answer and retries the same role once", async () => {
    await withTempDir(async (workspace) => {
      const handoff = ["# Spec\n", planResponse(chunkDefinition("chunk-a")), JSON.stringify(chunkDefinition("chunk-a"))].join("\n\n---\n\n");
      const state = {
        ...executionState("run-1", workspace, "developing"),
        transitionId: 4,
        pendingQuestion: {
          role: "developer" as const,
          question: "Need one detail?",
          handoff,
          index: 1,
          status: "pending" as const,
        },
      };
      const { agent, controller, store } = await createExecutionController(
        workspace,
        state,
        {
          developer: [JSON.stringify({ report: "implemented", deviated: false })],
          reviewer: [reviewerResponse()],
        },
        undefined,
        createUi({
          askQuestion: async (role, question) => {
            expect(role).toBe("developer");
            expect(question).toBe("Need one detail?");
            expect(agent.calls).toEqual([]);
            await expect(store.loadState()).resolves.toMatchObject({
              phase: "developing",
              transitionId: 4,
              pendingQuestion: {
                role: "developer",
                question: "Need one detail?",
                handoff,
                index: 1,
              },
            });
            return "Use the stored handoff";
          },
        }),
      );
      await store.writeJson(
        "questions/0001.json",
        { role: "developer", question: "Need one detail?" },
      );

      await controller.resume();

      await expect(store.loadState()).resolves.toMatchObject({ phase: "completed" });
      expect(agent.calls).toEqual([
        { role: "developer", handoff: `${handoff}\n\n---\n\nUse the stored handoff` },
        {
          role: "reviewer",
          handoff: [handoff, "implemented"].join("\n\n---\n\n"),
        },
      ]);
      await expect(readFile(questionPath(workspace, "run-1", 1), "utf8")).resolves.toBe(
        JSON.stringify({ role: "developer", question: "Need one detail?", answer: "Use the stored handoff" }),
      );
    });
  });

  it("retries an answered developer question after restart without re-asking and clears it only on success", async () => {
    await withTempDir(async (workspace) => {
      const handoff = ["# Spec\n", planResponse(chunkDefinition("chunk-a")), JSON.stringify(chunkDefinition("chunk-a"))].join("\n\n---\n\n");
      const state = {
        ...executionState("run-1", workspace, "developing"),
        transitionId: 5,
        pendingQuestion: {
          role: "developer" as const,
          question: "Need one detail?",
          handoff,
          index: 1,
          status: "answered" as const,
          answer: "Use the stored handoff",
        },
      };
      const { store } = await createExecutionController(
        workspace,
        state,
        {},
        undefined,
        createUi({
          askQuestion: async () => {
            throw new Error("should not ask again");
          },
        }),
      );
      await store.writeJson(
        "questions/0001.json",
        { role: "developer", question: "Need one detail?", answer: "Use the stored handoff" },
      );
      const agentCalls: Array<{ role: Role; handoff: string }> = [];
      const controller = new RunController({
        artifactStore: store,
        policy: defaultPolicy,
        roleAgent: {
          prompt: async (role, promptHandoff) => {
            agentCalls.push({ role, handoff: promptHandoff });

            if (role === "developer") {
              expect(JSON.parse(await readFile(join(runRoot(workspace, "run-1"), "state.json"), "utf8"))).toMatchObject({
                phase: "developing",
                transitionId: 6,
                pendingQuestion: {
                  role: "developer",
                  question: "Need one detail?",
                  handoff,
                  index: 1,
                  status: "answered",
                  answer: "Use the stored handoff",
                },
              });

              return JSON.stringify({ report: "implemented", deviated: false });
            }

            return reviewerResponse();
          },
        },
        ui: createUi({
          askQuestion: async () => {
            throw new Error("should not ask again");
          },
        }),
      });

      await controller.resume();

      await expect(store.loadState()).resolves.toMatchObject({ phase: "completed" });
      expect(agentCalls).toEqual([
        { role: "developer", handoff: `${handoff}\n\n---\n\nUse the stored handoff` },
        { role: "reviewer", handoff: [handoff, "implemented"].join("\n\n---\n\n") },
      ]);
    });
  });

  it.each([
    ["architect", "What scope?", "focus the spec", JSON.stringify({ specification: "# Spec\n" })],
    ["planner", "Which chunks?", "one chunk", planResponse(chunkDefinition("chunk-a"))],
    ["developer", "What implementation detail?", "keep it small", JSON.stringify({ report: "implemented", deviated: false })],
    ["reviewer", "Anything unclear?", "all clear", reviewerResponse()],
  ] as const)("retries %s questions after durably persisting the pending question", async (role, question, answer, finalResponse) => {
    await withTempDir(async (workspace) => {
      const ui = createQuestionRetryUi(workspace, role, question, answer, role === "architect" ? false : true);

      if (role === "architect") {
        const { agent, controller, store } = await createWorkflowController(
          workspace,
          { architect: [roleQuestionResponse(question), finalResponse] },
          ui,
        );

        await controller.start();

        await expect(store.loadState()).resolves.toMatchObject({ phase: "awaiting-spec-approval" });
        expect(agent.calls.map(({ role: callRole }) => callRole)).toEqual(["architect", "architect"]);
        await expect(readFile(questionPath(workspace, "run-1", 1), "utf8")).resolves.toBe(
          JSON.stringify({ role, question, answer }),
        );
        expect(agent.calls[1]?.handoff).toContain(answer);
        return;
      }

      if (role === "planner") {
        const { agent, controller, store } = await createPlanningController(
          workspace,
          "# Spec\n",
          [roleQuestionResponse(question), finalResponse],
          {
            developer: [JSON.stringify({ report: "implemented", deviated: false })],
            reviewer: [reviewerResponse()],
          },
          ui,
        );

        await controller.start();

        await expect(store.loadState()).resolves.toMatchObject({ phase: "completed" });
        expect(agent.calls[0]).toMatchObject({ role: "planner" });
        expect(agent.calls[1]).toMatchObject({ role: "planner" });
        expect(agent.calls[1]?.handoff).toContain(answer);
        await expect(readFile(questionPath(workspace, "run-1", 1), "utf8")).resolves.toBe(
          JSON.stringify({ role, question, answer }),
        );
        return;
      }

      if (role === "developer") {
        const { agent, controller, store } = await createExecutionController(
          workspace,
          executionState("run-1", workspace, "developing"),
          {
            developer: [roleQuestionResponse(question), JSON.stringify({ report: "implemented", deviated: false })],
            reviewer: [reviewerResponse()],
          },
          undefined,
          ui,
        );

        await controller.start();

        await expect(store.loadState()).resolves.toMatchObject({ phase: "completed" });
        expect(agent.calls[0]).toMatchObject({ role: "developer" });
        expect(agent.calls[1]).toMatchObject({ role: "developer" });
        expect(agent.calls[1]?.handoff).toContain(answer);
        await expect(readFile(questionPath(workspace, "run-1", 1), "utf8")).resolves.toBe(
          JSON.stringify({ role, question, answer }),
        );
        return;
      }

      const { agent, controller, store } = await createExecutionController(
        workspace,
        executionState("run-1", workspace, "reviewing"),
        {
          reviewer: [roleQuestionResponse(question), finalResponse],
        },
        "implemented",
        ui,
      );

      await controller.start();

      await expect(store.loadState()).resolves.toMatchObject({ phase: "completed" });
      expect(agent.calls[0]).toMatchObject({ role: "reviewer" });
      expect(agent.calls[1]).toMatchObject({ role: "reviewer" });
      expect(agent.calls[1]?.handoff).toContain(answer);
      await expect(readFile(questionPath(workspace, "run-1", 1), "utf8")).resolves.toBe(
        JSON.stringify({ role, question, answer }),
      );
    });
  });
});
