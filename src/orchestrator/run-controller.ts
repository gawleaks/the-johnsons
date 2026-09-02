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
const validFindingSeverities = new Set<ReviewerFinding["severity"]>(["blocker", "major", "minor"]);
const validReviewStatuses = new Set<ReviewerAcceptanceCriterion["status"]>(["pass", "fail"]);

interface ReviewerFinding {
  readonly severity: "blocker" | "major" | "minor";
  readonly location: string;
  readonly problem: string;
  readonly requiredFix: string;
}

interface ReviewerAcceptanceCriterion {
  readonly id: string;
  readonly status: "pass" | "fail";
}

interface ReviewerCheck {
  readonly command: string;
  readonly status: "pass" | "fail";
  readonly evidence: string;
}

interface ReviewerOutput {
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: ReadonlyArray<ReviewerFinding>;
  readonly acceptanceCriteria: ReadonlyArray<ReviewerAcceptanceCriterion>;
  readonly checks: ReadonlyArray<ReviewerCheck>;
}

const isReviewerFindingSeverity = (value: unknown): value is ReviewerFinding["severity"] =>
  typeof value === "string" && validFindingSeverities.has(value as ReviewerFinding["severity"]);

const isReviewerStatus = (value: unknown): value is ReviewerAcceptanceCriterion["status"] =>
  typeof value === "string" && validReviewStatuses.has(value as ReviewerAcceptanceCriterion["status"]);

const hasExactAcceptancePasses = (
  actual: ReadonlyArray<ReviewerAcceptanceCriterion>,
  expected: ReadonlyArray<string>,
): boolean => {
  if (actual.length !== expected.length) {
    return false;
  }

  return expected.every((value) =>
    actual.filter((entry) => entry.id === value && entry.status === "pass").length === 1,
  );
};

const hasExactCheckPasses = (
  actual: ReadonlyArray<ReviewerCheck>,
  expected: ReadonlyArray<string>,
): boolean => {
  if (actual.length !== expected.length) {
    return false;
  }

  return expected.every((value) =>
    actual.filter((entry) => entry.command === value && entry.status === "pass").length === 1,
  );
};

const isApprovalSatisfied = (review: ReviewerOutput, chunk: ChunkDefinition): boolean =>
  review.findings.every(({ severity }) => severity === "minor")
  && hasExactAcceptancePasses(review.acceptanceCriteria, chunk.acceptanceCriteria.map(({ id }) => id))
  && hasExactCheckPasses(review.checks, chunk.requiredChecks);

const parseReviewerOutput = (output: string, chunk: ChunkDefinition): { readonly verdict: ReviewVerdict; readonly report: string } => {
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
  const requiredKeys = ["verdict", "summary", "findings", "acceptanceCriteria", "checks"];
  if (keys.length !== requiredKeys.length || requiredKeys.some((key) => !keys.includes(key))) {
    throw new Error("Invalid reviewer output");
  }

  if (!validReviewerVerdicts.has(parsed.verdict as ReviewVerdict) || !isNonEmptyString(parsed.summary)) {
    throw new Error("Invalid reviewer output");
  }

  if (!Array.isArray(parsed.findings) || !Array.isArray(parsed.acceptanceCriteria) || !Array.isArray(parsed.checks)) {
    throw new Error("Invalid reviewer output");
  }

  const findings = parsed.findings.map((finding) => {
    if (!isRecord(finding)) {
      throw new Error("Invalid reviewer output");
    }

    const findingKeys = Object.keys(finding);
    if (findingKeys.length !== 4 || ["severity", "location", "problem", "requiredFix"].some((key) => !findingKeys.includes(key))) {
      throw new Error("Invalid reviewer output");
    }

    if (!isReviewerFindingSeverity(finding.severity) || !isNonEmptyString(finding.location) || !isNonEmptyString(finding.problem) || !isNonEmptyString(finding.requiredFix)) {
      throw new Error("Invalid reviewer output");
    }

    return {
      severity: finding.severity,
      location: finding.location,
      problem: finding.problem,
      requiredFix: finding.requiredFix,
    };
  });

  const acceptanceCriteria = parsed.acceptanceCriteria.map((criterion) => {
    if (!isRecord(criterion)) {
      throw new Error("Invalid reviewer output");
    }

    const criterionKeys = Object.keys(criterion);
    if (criterionKeys.length !== 2 || !criterionKeys.includes("id") || !criterionKeys.includes("status")) {
      throw new Error("Invalid reviewer output");
    }

    if (!isNonEmptyString(criterion.id) || !isReviewerStatus(criterion.status)) {
      throw new Error("Invalid reviewer output");
    }

    return {
      id: criterion.id,
      status: criterion.status,
    };
  });

  const checks = parsed.checks.map((check) => {
    if (!isRecord(check)) {
      throw new Error("Invalid reviewer output");
    }

    const checkKeys = Object.keys(check);
    if (checkKeys.length !== 3 || !checkKeys.includes("command") || !checkKeys.includes("status") || !checkKeys.includes("evidence")) {
      throw new Error("Invalid reviewer output");
    }

    if (!isNonEmptyString(check.command) || !isReviewerStatus(check.status) || !isNonEmptyString(check.evidence)) {
      throw new Error("Invalid reviewer output");
    }

    return {
      command: check.command,
      status: check.status,
      evidence: check.evidence,
    };
  });

  const review = {
    verdict: parsed.verdict as ReviewVerdict,
    summary: parsed.summary,
    findings,
    acceptanceCriteria,
    checks,
  } satisfies ReviewerOutput;

  if (review.verdict === "approved" && !isApprovalSatisfied(review, chunk)) {
    throw new Error("Invalid reviewer output");
  }

  return { verdict: review.verdict, report: output };
};

const listQuestionIndexes = async (artifactStore: ArtifactStore): Promise<ReadonlyArray<number>> => {
  try {
    return (await artifactStore.listFiles(questionsPath))
      .map((name) => name.match(/^(\d+)\.json$/)?.[1])
      .filter((index): index is string => index !== undefined)
      .map((index) => Number.parseInt(index, 10));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
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

      return this.requestSpecificationApproval(afterSpecification, specification);
    }

    if (state.phase === "awaiting-spec-approval") {
      return this.requestSpecificationApproval(state);
    }

    return this.advanceWorkflow(state);
  }

  async resume(): Promise<RunState> {
    const state = await this.deps.artifactStore.loadState();

    if (state.phase === "awaiting-spec-approval") {
      return this.requestSpecificationApproval(state);
    }

    if (state.phase === "escalated") {
      return this.resolveEscalation(state);
    }

    return this.advanceWorkflow(state);
  }

  async answerUserQuestion(role: Role, question: string): Promise<string> {
    const answer = await this.deps.ui.askQuestion(role, question);
    const state = await this.deps.artifactStore.loadState();
    const nextIndex = Math.max(0, ...await listQuestionIndexes(this.deps.artifactStore)) + 1;

    await this.deps.artifactStore.writeJson(questionArtifactPath(nextIndex), { role, question, answer });

    return answer;
  }

  private async requestSpecificationApproval(
    state: RunState,
    specification?: string,
  ): Promise<RunState> {
    const currentSpecification = specification ?? await this.deps.artifactStore.readText("specification.md");
    const approved = await this.deps.ui.approveSpecification(currentSpecification);
    if (!approved) {
      return state;
    }

    const next = applyTransition(
      state,
      { type: "specification-approved" },
      this.deps.policy,
    );
    await this.deps.artifactStore.appendTransition(
      { type: "specification-approved" },
      next,
    );

    return this.advanceWorkflow(next);
  }

  private async startPlanning(state: RunState): Promise<RunState> {
    const plannerOutput = await this.deps.roleAgent.prompt(
      "planner",
      buildRoleHandoff("planner", { specification: await this.deps.artifactStore.readText("specification.md") }),
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

  private async advanceWorkflow(initialState: RunState): Promise<RunState> {
    let state = initialState;

    while (state.phase === "planning" || state.phase === "developing" || state.phase === "reviewing") {
      state = state.phase === "planning"
        ? await this.startPlanning(state)
        : state.phase === "developing"
          ? await this.finishDevelopment(state)
          : await this.finishReview(state);
    }

    return state;
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
    const specification = await this.deps.artifactStore.readText("specification.md");
    const plan = await this.deps.artifactStore.readText("plan.md");
    const chunkId = activeChunkId(state);
    const chunk = await this.deps.artifactStore.readText(chunkDefinitionPath(chunkId));
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
    const specification = await this.deps.artifactStore.readText("specification.md");
    const plan = await this.deps.artifactStore.readText("plan.md");
    const chunkId = activeChunkId(state);
    const chunk = await this.deps.artifactStore.readText(chunkDefinitionPath(chunkId));
    const review = await this.deps.artifactStore.readText(implementationReportPath(chunkId));
    const reviewerOutput = await this.deps.roleAgent.prompt(
      "reviewer",
      buildRoleHandoff("reviewer", { specification, plan, chunk, review }),
    );
    const { verdict, report } = parseReviewerOutput(reviewerOutput, parseChunkDefinition(JSON.parse(chunk)));
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
