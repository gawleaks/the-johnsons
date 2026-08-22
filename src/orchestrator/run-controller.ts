import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { applyTransition } from "../domain/workflow.js";
import type {
  AcceptanceCriterion,
  ChunkDefinition,
  ChunkState,
  ReviewVerdict,
  Role,
  RunState,
} from "../domain/types.js";
import type { Policy } from "../policy/config.js";
import { buildRoleHandoff } from "../policy/prompts.js";
import type { ArtifactStore } from "../storage/artifact-store.js";

export interface RoleAgent {
  prompt(role: Role, handoff: string): Promise<string>;
}

export interface RunUi {
  approveSpecification(specification: string): Promise<boolean>;
  askQuestion(role: Role, question: string): Promise<string>;
  resolveEscalation(): Promise<boolean>;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const isValidChunkId = (id: string): boolean =>
  id !== "" && id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\");

const parseStringList = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
    throw new Error("Invalid planner output");
  }

  return value;
};

const parseAcceptanceCriteria = (value: unknown): ReadonlyArray<AcceptanceCriterion> => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Invalid planner output");
  }

  return value.map((criterion) => {
    if (!isRecord(criterion)) {
      throw new Error("Invalid planner output");
    }

    const keys = Object.keys(criterion);
    if (keys.length !== 2 || !keys.includes("id") || !keys.includes("text")) {
      throw new Error("Invalid planner output");
    }

    if (!isNonEmptyString(criterion.id) || !isNonEmptyString(criterion.text)) {
      throw new Error("Invalid planner output");
    }

    return { id: criterion.id, text: criterion.text };
  });
};

const parseChunkDefinition = (value: unknown): ChunkDefinition => {
  if (!isRecord(value)) {
    throw new Error("Invalid planner output");
  }

  const keys = Object.keys(value);
  const requiredKeys = [
    "id",
    "scope",
    "nonGoals",
    "prerequisites",
    "touchedAreas",
    "acceptanceCriteria",
    "requiredChecks",
    "handoffArtifacts",
    "recoveryNotes",
  ];

  if (keys.length !== requiredKeys.length || requiredKeys.some((key) => !keys.includes(key))) {
    throw new Error("Invalid planner output");
  }

  if (!isNonEmptyString(value.id) || !isValidChunkId(value.id) || !isNonEmptyString(value.scope)) {
    throw new Error("Invalid planner output");
  }

  return {
    id: value.id,
    scope: value.scope,
    nonGoals: parseStringList(value.nonGoals),
    prerequisites: parseStringList(value.prerequisites),
    touchedAreas: parseStringList(value.touchedAreas),
    acceptanceCriteria: parseAcceptanceCriteria(value.acceptanceCriteria),
    requiredChecks: parseStringList(value.requiredChecks),
    handoffArtifacts: parseStringList(value.handoffArtifacts),
    recoveryNotes: parseStringList(value.recoveryNotes),
  };
};

const normalizeChunkState = ({ id }: ChunkDefinition): ChunkState => ({
  id,
  status: "pending",
  reviewAttempts: 0,
});

const parsePlan = (output: string): {
  readonly definitions: ReadonlyArray<ChunkDefinition>;
  readonly chunks: ReadonlyArray<ChunkState>;
} => {
  const parsed: unknown = JSON.parse(output);

  if (!isRecord(parsed)) {
    throw new Error("Invalid planner output");
  }

  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "chunks") {
    throw new Error("Invalid planner output");
  }

  const planChunks = parsed.chunks;
  if (!Array.isArray(planChunks) || planChunks.length === 0) {
    throw new Error("Invalid planner output");
  }

  const definitions = planChunks.map(parseChunkDefinition);
  if (new Set(definitions.map(({ id }) => id)).size !== definitions.length) {
    throw new Error("Invalid planner output");
  }

  return {
    definitions,
    chunks: definitions.map(normalizeChunkState),
  };
};

const runRoot = (state: RunState): string => join(state.workspace, ".johnsons", "runs", state.runId);
const runArtifactPath = (state: RunState, name: string): string => join(runRoot(state), name);
const chunkDefinitionPath = (id: string): string => join("chunks", id, "definition.md");
const implementationReportPath = (id: string): string => join("chunks", id, "implementation-report.md");
const reviewArtifactPath = (id: string, attempt: number): string => join("chunks", id, `review-${attempt}.md`);
const questionsPath = "questions";
const questionArtifactPath = (index: number): string => join(questionsPath, `${index.toString().padStart(4, "0")}.json`);

const activeChunkId = (state: RunState): string => {
  if (!state.activeChunkId) {
    throw new Error(`Missing active chunk for ${state.phase}`);
  }

  return state.activeChunkId;
};

const parseDeveloperOutput = (output: string): { readonly report: string; readonly deviated: boolean } => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Invalid developer output");
  }

  if (!isRecord(parsed)) {
    throw new Error("Invalid developer output");
  }

  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes("report") || !keys.includes("deviated")) {
    throw new Error("Invalid developer output");
  }

  if (!isNonEmptyString(parsed.report) || typeof parsed.deviated !== "boolean") {
    throw new Error("Invalid developer output");
  }

  return { report: parsed.report, deviated: parsed.deviated };
};

const validReviewerVerdicts = new Set<ReviewVerdict>(["approved", "rejected", "escalate"]);

const parseReviewerOutput = (output: string): { readonly verdict: ReviewVerdict; readonly report: string } => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Invalid reviewer output");
  }

  if (!isRecord(parsed)) {
    throw new Error("Invalid reviewer output");
  }

  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes("verdict") || !keys.includes("report")) {
    throw new Error("Invalid reviewer output");
  }

  if (!validReviewerVerdicts.has(parsed.verdict as ReviewVerdict) || !isNonEmptyString(parsed.report)) {
    throw new Error("Invalid reviewer output");
  }

  return { verdict: parsed.verdict as ReviewVerdict, report: parsed.report };
};

const listQuestionIndexes = async (state: RunState): Promise<ReadonlyArray<number>> => {
  try {
    const entries = await readdir(runArtifactPath(state, questionsPath), { withFileTypes: true });

    return entries
      .filter((entry) => entry.isFile())
      .map(({ name }) => name.match(/^(\d+)\.json$/)?.[1])
      .filter((index): index is string => index !== undefined)
      .map((index) => Number.parseInt(index, 10));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
};

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

    if (state.phase === "developing" || state.phase === "reviewing") {
      return this.runExecutionLoop(state);
    }

    return state;
  }

  async resume(): Promise<RunState> {
    const state = await this.deps.artifactStore.loadState();

    if (state.phase === "planning") {
      return this.startPlanning(state);
    }

    if (state.phase === "developing" || state.phase === "reviewing") {
      return this.runExecutionLoop(state);
    }

    if (state.phase === "escalated") {
      return this.resolveEscalation(state);
    }

    return state;
  }

  async answerUserQuestion(role: Role, question: string): Promise<string> {
    const answer = await this.deps.ui.askQuestion(role, question);
    const state = await this.deps.artifactStore.loadState();
    const nextIndex = Math.max(0, ...await listQuestionIndexes(state)) + 1;

    await this.deps.artifactStore.writeJson(questionArtifactPath(nextIndex), { role, question, answer });

    return answer;
  }

  private async startPlanning(state: RunState): Promise<RunState> {
    const plannerOutput = await this.deps.roleAgent.prompt(
      "planner",
      buildRoleHandoff("planner", { specification: await readFile(runArtifactPath(state, "specification.md"), "utf8") }),
    );
    const { definitions, chunks } = parsePlan(plannerOutput);

    await this.deps.artifactStore.writeText("plan.md", plannerOutput);
    await Promise.all(
      definitions.map(async (definition) =>
        this.deps.artifactStore.writeText(
          chunkDefinitionPath(definition.id),
          JSON.stringify(definition),
        ),
      ),
    );

    const next = applyTransition(state, { type: "plan-created", chunks }, this.deps.policy);
    await this.deps.artifactStore.appendTransition({ type: "plan-created", chunks }, next);

    return next;
  }

  private async runExecutionLoop(initialState: RunState): Promise<RunState> {
    let state = initialState;

    while (state.phase === "developing" || state.phase === "reviewing") {
      state = state.phase === "developing"
        ? await this.finishDevelopment(state)
        : await this.finishReview(state);
    }

    return state;
  }

  private async finishDevelopment(state: RunState): Promise<RunState> {
    const specification = await readFile(runArtifactPath(state, "specification.md"), "utf8");
    const plan = await readFile(runArtifactPath(state, "plan.md"), "utf8");
    const chunkId = activeChunkId(state);
    const chunk = await readFile(runArtifactPath(state, chunkDefinitionPath(chunkId)), "utf8");
    const developerOutput = await this.deps.roleAgent.prompt(
      "developer",
      buildRoleHandoff("developer", { specification, plan, chunk }),
    );
    const { report, deviated } = parseDeveloperOutput(developerOutput);

    await this.deps.artifactStore.writeText(implementationReportPath(chunkId), report);

    const next = applyTransition(state, { type: "developer-finished", deviated }, this.deps.policy);
    await this.deps.artifactStore.appendTransition({ type: "developer-finished", deviated }, next);

    return next;
  }

  private async resolveEscalation(state: RunState): Promise<RunState> {
    const resume = await this.deps.ui.resolveEscalation();
    const next = applyTransition(state, { type: "user-escalated-resolution", resume }, this.deps.policy);
    await this.deps.artifactStore.appendTransition({ type: "user-escalated-resolution", resume }, next);

    return resume ? this.runExecutionLoop(next) : next;
  }

  private async finishReview(state: RunState): Promise<RunState> {
    const specification = await readFile(runArtifactPath(state, "specification.md"), "utf8");
    const plan = await readFile(runArtifactPath(state, "plan.md"), "utf8");
    const chunkId = activeChunkId(state);
    const chunk = await readFile(runArtifactPath(state, chunkDefinitionPath(chunkId)), "utf8");
    const review = await readFile(runArtifactPath(state, implementationReportPath(chunkId)), "utf8");
    const reviewerOutput = await this.deps.roleAgent.prompt(
      "reviewer",
      buildRoleHandoff("reviewer", { specification, plan, chunk, review }),
    );
    const { verdict, report } = parseReviewerOutput(reviewerOutput);
    const attempt = state.chunks.find(({ id }) => id === chunkId)?.reviewAttempts;

    if (attempt === undefined) {
      throw new Error(`Missing active chunk for ${state.phase}`);
    }

    await this.deps.artifactStore.writeText(reviewArtifactPath(chunkId, attempt + 1), report);

    const next = applyTransition(state, { type: "reviewed", verdict }, this.deps.policy);
    await this.deps.artifactStore.appendTransition({ type: "reviewed", verdict }, next);

    return next;
  }
}
