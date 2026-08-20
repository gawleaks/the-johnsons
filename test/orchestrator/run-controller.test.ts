import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createRunState } from "../../src/domain/types.js";
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

const planningState = (runId: string, workspace: string) => ({
  version: 1 as const,
  runId,
  workspace,
  phase: "planning" as const,
  chunks: [],
  transitionId: 2,
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
  const ui = {
    approveSpecification: async (specification: string) => {
      onApproveSpecification?.(specification);
      return approved;
    },
  };

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
    ui: { approveSpecification: async () => true },
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
        ui: { approveSpecification: async () => true },
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
  it("writes the plan and chunk definitions, then activates the first chunk", async () => {
    await withTempDir(async (workspace) => {
      const specification = "# Spec\n";
      const plannerResponse = JSON.stringify({ chunks: [{ id: "chunk-a" }, { id: "chunk-b" }] });
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
        JSON.stringify({ id: "chunk-a" }),
      );
      await expect(readFile(chunkDefinitionPath(workspace, "run-1", "chunk-b"), "utf8")).resolves.toBe(
        JSON.stringify({ id: "chunk-b" }),
      );
      expect(agent.calls).toEqual([{ role: "planner", handoff: specification }]);
    });
  });

  it.each([
    ["malformed JSON", "not json"],
    ["empty chunks", JSON.stringify({ chunks: [] })],
    ["empty chunk id", JSON.stringify({ chunks: [{ id: "" }] })],
    ["duplicate chunk ids", JSON.stringify({ chunks: [{ id: "chunk-a" }, { id: "chunk-a" }] })],
    ["extra chunk fields", JSON.stringify({ chunks: [{ id: "chunk-a", extra: true }] })],
    ["non-object chunk entry", JSON.stringify({ chunks: ["chunk-a"] })],
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
      const plannerResponse = JSON.stringify({ chunks: [{ id: "chunk-a" }] });
      const { agent, controller } = await createPlanningController(workspace, specification, plannerResponse);

      await controller.start();

      expect(agent.calls).toEqual([{ role: "planner", handoff: specification }]);
    });
  });
});
