import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyTransition } from "../domain/workflow.js";
import type { ChunkState, Role, RunState } from "../domain/types.js";
import type { Policy } from "../policy/config.js";
import { buildRoleHandoff } from "../policy/prompts.js";
import type { ArtifactStore } from "../storage/artifact-store.js";

export interface RoleAgent {
  prompt(role: Role, handoff: string): Promise<string>;
}

export interface RunUi {
  approveSpecification(specification: string): Promise<boolean>;
}

export interface RunControllerDeps {
  readonly artifactStore: ArtifactStore;
  readonly policy: Policy;
  readonly roleAgent: RoleAgent;
  readonly ui: RunUi;
}

const parseSpecification = (output: string): string => {
  const parsed: unknown = JSON.parse(output);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid architect output");
  }

  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "specification") {
    throw new Error("Invalid architect output");
  }

  const specification = (parsed as { specification?: unknown }).specification;
  if (typeof specification !== "string" || specification.trim() === "") {
    throw new Error("Invalid architect output");
  }

  return specification;
};

const isValidChunkId = (id: string): boolean =>
  id !== "" && id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\");

const parsePlan = (output: string): ReadonlyArray<ChunkState> => {
  const parsed: unknown = JSON.parse(output);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid planner output");
  }

  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "chunks") {
    throw new Error("Invalid planner output");
  }

  const chunks = (parsed as { chunks?: unknown }).chunks;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error("Invalid planner output");
  }

  const normalized = chunks.map((chunk) => {
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
      throw new Error("Invalid planner output");
    }

    const chunkKeys = Object.keys(chunk);
    if (chunkKeys.length !== 1 || chunkKeys[0] !== "id") {
      throw new Error("Invalid planner output");
    }

    const id = (chunk as { id?: unknown }).id;
    if (typeof id !== "string" || !isValidChunkId(id)) {
      throw new Error("Invalid planner output");
    }

    return { id, status: "pending", reviewAttempts: 0 } as const;
  });

  if (new Set(normalized.map(({ id }) => id)).size !== normalized.length) {
    throw new Error("Invalid planner output");
  }

  return normalized;
};

const runRoot = (state: RunState): string => join(state.workspace, ".johnsons", "runs", state.runId);
const runArtifactPath = (state: RunState, name: string): string => join(runRoot(state), name);
const chunkDefinitionPath = (id: string): string => join("chunks", id, "definition.md");

export class RunController {
  constructor(private readonly deps: RunControllerDeps) {}

  async start(): Promise<RunState> {
    const state = await this.deps.artifactStore.loadState();

    if (state.phase === "architecting") {
      const architectOutput = await this.deps.roleAgent.prompt(
        "architect",
        buildRoleHandoff("architect", {}),
      );
      const specification = parseSpecification(architectOutput);

      await this.deps.artifactStore.writeText("specification.md", specification);

      const afterSpecification = applyTransition(
        state,
        { type: "specification-created" },
        this.deps.policy,
      );
      await this.deps.artifactStore.appendTransition(
        { type: "specification-created" },
        afterSpecification,
      );

      const approved = await this.deps.ui.approveSpecification(specification);
      if (!approved) {
        return afterSpecification;
      }

      const next = applyTransition(
        afterSpecification,
        { type: "specification-approved" },
        this.deps.policy,
      );
      await this.deps.artifactStore.appendTransition(
        { type: "specification-approved" },
        next,
      );

      return next;
    }

    if (state.phase === "planning") {
      return this.startPlanning(state);
    }

    return state;
  }

  private async startPlanning(state: RunState): Promise<RunState> {
    const plannerOutput = await this.deps.roleAgent.prompt(
      "planner",
      buildRoleHandoff("planner", { specification: await readFile(runArtifactPath(state, "specification.md"), "utf8") }),
    );
    const chunks = parsePlan(plannerOutput);

    await this.deps.artifactStore.writeText("plan.md", plannerOutput);
    await Promise.all(
      chunks.map(async (chunk) =>
        this.deps.artifactStore.writeText(chunkDefinitionPath(chunk.id), JSON.stringify({ id: chunk.id })),
      ),
    );

    const next = applyTransition(state, { type: "plan-created", chunks }, this.deps.policy);
    await this.deps.artifactStore.appendTransition({ type: "plan-created", chunks }, next);

    return next;
  }
}
