import { applyTransition } from "../domain/workflow.js";
import type { Role, RunState } from "../domain/types.js";
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

export class RunController {
  constructor(private readonly deps: RunControllerDeps) {}

  async start(): Promise<RunState> {
    const state = await this.deps.artifactStore.loadState();

    if (state.phase !== "architecting") {
      return state;
    }

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
}
