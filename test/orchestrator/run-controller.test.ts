import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createRunState, type RunState } from "../../src/domain/types.js";
import { ArtifactStore } from "../../src/storage/artifact-store.js";
import { defaultPolicy } from "../../src/policy/config.js";
import { RunController } from "../../src/orchestrator/run-controller.js";
import { createFakeAgent } from "../helpers/fake-agent.js";

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

const createPlanningController = async (
  workspace: string,
  specification: string,
  plannerResponse: string,
) => {
  const runId = "run-1";
  const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
  await store.writeText("specification.md", specification);
  await store.writeJson("state.json", planningState(runId, workspace));
  const agent = createFakeAgent({ planner: [plannerResponse] });
  const controller = new RunController({
    artifactStore: store,
    policy: defaultPolicy,
    roleAgent: agent,
    ui: createUi(),
  });

  return { agent, controller, store };
};

const createExecutionController = async (
  workspace: string,
  state: RunState,
  responses: Partial<Record<"developer" | "reviewer", ReadonlyArray<string>>>,
  implementationReport?: string,
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
    ui: createUi(),
  });

  return { agent, controller, store };
};

describe("RunController slice 1", () => {
  it("writes the architect specification and reaches planning after approval", async () => {
    await withTempDir(async (workspace) => {
      let approvedSpecification = "";
      const { agent, controller, store } = await createController(
        workspace,
        JSON.stringify({ specification: "# Spec\n" }),
        true,
        (specification) => {
          approvedSpecification = specification;
        },
      );

      await controller.start();

      await expect(store.loadState()).resolves.toMatchObject({ phase: "planning", transitionId: 2 });
      await expect(readFile(specPath(workspace, "run-1"), "utf8")).resolves.toBe("# Spec\n");
      expect(approvedSpecification).toBe("# Spec\n");
      expect(agent.calls).toEqual([{ role: "architect", handoff: expect.any(String) }]);
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

      await expect(store.loadState()).resolves.toMatchObject({ phase: "awaiting-spec-approval", transitionId: 1 });
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
      await expect(store.loadState()).resolves.toMatchObject({ phase: "architecting", transitionId: 0 });
      expect(agent.calls.map(({ role }) => role)).toEqual(["architect"]);
      await expect(readFile(specPath(workspace, runId), "utf8")).rejects.toThrow();
    });
  });

  it("does not call the planner in slice 1", async () => {
    await withTempDir(async (workspace) => {
      const { agent, controller } = await createController(
        workspace,
        JSON.stringify({ specification: "# Spec\n" }),
        true,
      );

      await controller.start();

      expect(agent.calls.map(({ role }) => role)).toEqual(["architect"]);
    });
  });
});

describe("RunController slice 2", () => {
  it("writes the full plan and full chunk definitions, then activates the first chunk", async () => {
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
      );

      await controller.start();

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "developing",
        activeChunkId: "chunk-a",
        transitionId: 3,
        chunks: [
          { id: "chunk-a", status: "developing", reviewAttempts: 0 },
          { id: "chunk-b", status: "pending", reviewAttempts: 0 },
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
      expect(agent.calls).toEqual([{ role: "planner", handoff: specification }]);
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
      await expect(store.loadState()).resolves.toMatchObject({ phase: "planning", transitionId: 2 });
      expect(agent.calls.map(({ role }) => role)).toEqual(["planner"]);
      await expect(readFile(planPath(workspace, "run-1"), "utf8")).rejects.toThrow();
      await expect(readFile(chunkDefinitionPath(workspace, "run-1", "chunk-a"), "utf8")).rejects.toThrow();
    });
  });

  it("sends the exact specification handoff to the planner", async () => {
    await withTempDir(async (workspace) => {
      const specification = "# Spec\n\n- one\n";
      const plannerResponse = planResponse(chunkDefinition("chunk-a"));
      const { agent, controller } = await createPlanningController(workspace, specification, plannerResponse);

      await controller.start();

      expect(agent.calls).toEqual([{ role: "planner", handoff: specification }]);
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
          reviewer: [JSON.stringify({ verdict: "approved", report: "looks good" })],
        },
      );

      await controller.start();

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "completed",
        transitionId: 5,
        chunks: [{ id: "chunk-a", status: "approved", reviewAttempts: 0 }],
      });
      await expect(readFile(implementationReportPath(workspace, "run-1", "chunk-a"), "utf8")).resolves.toBe("implemented");
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 1), "utf8")).resolves.toBe("looks good");
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
            JSON.stringify({ verdict: "rejected", report: "try again" }),
            JSON.stringify({ verdict: "approved", report: "now good" }),
          ],
        },
      );

      await controller.start();

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "completed",
        transitionId: 7,
        chunks: [{ id: "chunk-a", status: "approved", reviewAttempts: 1 }],
      });
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 1), "utf8")).resolves.toBe("try again");
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 2), "utf8")).resolves.toBe("now good");
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
          reviewer: [JSON.stringify({ verdict: "rejected", report: "still broken" })],
        },
      );

      await controller.start();

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "escalated",
        activeChunkId: "chunk-a",
        transitionId: 5,
        chunks: [{ id: "chunk-a", status: "escalated", reviewAttempts: 2 }],
      });
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 2), "utf8")).resolves.toBe("still broken");
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
        transitionId: 4,
        chunks: [{ id: "chunk-a", status: "escalated", reviewAttempts: 0 }],
      });
      await expect(readFile(implementationReportPath(workspace, "run-1", "chunk-a"), "utf8")).resolves.toBe("need help");
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 1), "utf8")).rejects.toThrow();
      expect(agent.calls.map(({ role }) => role)).toEqual(["developer"]);
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
      await expect(store.loadState()).resolves.toEqual(initialState);
      await expect(readFile(implementationReportPath(workspace, "run-1", "chunk-a"), "utf8")).rejects.toThrow();
    });
  });

  it.each([
    ["not json", "Invalid reviewer output"],
    [JSON.stringify({ verdict: "approved", report: "" }), "Invalid reviewer output"],
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
      await expect(store.loadState()).resolves.toEqual(initialState);
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 1), "utf8")).rejects.toThrow();
    });
  });
});

describe("RunController slice 4", () => {
  it("resumes from planning by dispatching only planner and preserving existing specification", async () => {
    await withTempDir(async (workspace) => {
      const { store } = await createPlanningController(
        workspace,
        "# Existing spec\n",
        planResponse(chunkDefinition("chunk-a")),
      );
      const originalSpec = await readFile(specPath(workspace, "run-1"), "utf8");
      const agent = createFakeAgent({ planner: [planResponse(chunkDefinition("chunk-a"))] });
      const controller = new RunController({
        artifactStore: store,
        policy: defaultPolicy,
        roleAgent: agent,
        ui: createUi(),
      });

      await controller.resume();

      await expect(store.loadState()).resolves.toMatchObject({
        phase: "developing",
        activeChunkId: "chunk-a",
      });
      await expect(readFile(specPath(workspace, "run-1"), "utf8")).resolves.toBe(originalSpec);
      expect(agent.calls.map(({ role }) => role)).toEqual(["planner"]);
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
        reviewer: [JSON.stringify({ verdict: "approved", report: "approved" })],
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
        reviewer: [JSON.stringify({ verdict: "approved", report: "done" })],
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
        transitionId: 8,
        chunks: [{ id: "chunk-a", status: "approved", reviewAttempts: 1 }],
      });
      expect(agent.calls.map(({ role }) => role)).toEqual(["developer", "reviewer"]);
      await expect(readFile(reviewPath(workspace, "run-1", "chunk-a", 2), "utf8")).resolves.toBe("done");
    });
  });
});
