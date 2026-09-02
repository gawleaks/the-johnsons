import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appendJsonLine, atomicWrite, safeRelativePath } from "./files.js";
import type { ChunkState, PendingQuestion, Role, RunState, Transition } from "../domain/types.js";

const stateFileName = "state.json";
const transitionsFileName = "transitions.jsonl";
const validPhases = new Set<RunState["phase"]>([
  "architecting",
  "awaiting-spec-approval",
  "planning",
  "developing",
  "reviewing",
  "escalated",
  "completed",
  "failed",
]);
const validChunkStatuses = new Set<ChunkState["status"]>([
  "pending",
  "developing",
  "reviewing",
  "approved",
  "escalated",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const validRoles = new Set<Role>(["architect", "planner", "developer", "reviewer"]);

const parseChunk = (value: unknown): ChunkState => {
  if (!isRecord(value)) {
    throw new Error("Invalid chunk state");
  }

  if (!isString(value.id) || !validChunkStatuses.has(value.status as ChunkState["status"]) || !isNumber(value.reviewAttempts)) {
    throw new Error("Invalid chunk state");
  }

  return {
    id: value.id,
    status: value.status as ChunkState["status"],
    reviewAttempts: value.reviewAttempts,
  };
};

const parsePendingQuestion = (value: unknown): PendingQuestion => {
  if (
    !isRecord(value)
    || !isString(value.role)
    || !validRoles.has(value.role as Role)
    || !isString(value.question)
    || value.question.trim() === ""
    || !isString(value.handoff)
    || !isNumber(value.index)
    || value.index < 1
  ) {
    throw new Error("Invalid run state");
  }

  return {
    role: value.role as Role,
    question: value.question,
    handoff: value.handoff,
    index: value.index,
  };
};

const parseState = (value: unknown): RunState => {
  if (!isRecord(value)) {
    throw new Error("Invalid run state");
  }

  if (
    value.version !== 1 ||
    !isString(value.runId) ||
    !isString(value.workspace) ||
    !validPhases.has(value.phase as RunState["phase"]) ||
    !Array.isArray(value.chunks) ||
    !isNumber(value.transitionId)
  ) {
    throw new Error("Invalid run state");
  }

  const activeChunkId = value.activeChunkId;
  const pendingQuestion = value.pendingQuestion;

  if (activeChunkId !== undefined && !isString(activeChunkId)) {
    throw new Error("Invalid run state");
  }

  return {
    version: 1,
    runId: value.runId,
    workspace: value.workspace,
    phase: value.phase as RunState["phase"],
    chunks: value.chunks.map(parseChunk),
    ...(activeChunkId === undefined ? {} : { activeChunkId }),
    ...(pendingQuestion === undefined ? {} : { pendingQuestion: parsePendingQuestion(pendingQuestion) }),
    transitionId: value.transitionId,
  };
};

const safeRunId = (runId: string): string => {
  if (runId.length === 0 || runId === "." || runId === ".." || runId.includes("/") || runId.includes("\\")) {
    throw new Error(`Invalid run id: ${runId}`);
  }

  return runId;
};

const runRoot = (workspace: string, runId: string): string => join(workspace, ".johnsons", "runs", safeRunId(runId));

const artifactPath = (workspace: string, runId: string, name: string): string =>
  safeRelativePath(runRoot(workspace, runId), name);

const isExecutionWorkspace = (artifactWorkspace: string, runId: string, executionWorkspace: string): boolean => {
  const root = resolve(artifactWorkspace);

  return executionWorkspace === root || executionWorkspace === join(root, ".johnsons", "worktrees", runId);
};

const validateInitialIdentity = (workspace: string, runId: string, initial: RunState): void => {
  if (initial.runId !== runId || !isExecutionWorkspace(workspace, runId, initial.workspace)) {
    throw new Error("Initial run state does not match artifact store identity");
  }
};

const validateLoadedState = (workspace: string, runId: string, state: RunState): void => {
  if (state.runId !== runId || !isExecutionWorkspace(workspace, runId, state.workspace)) {
    throw new Error("Invalid run state");
  }

  if (state.pendingQuestion !== undefined) {
    if (!["architecting", "planning", "developing", "reviewing"].includes(state.phase)) {
      throw new Error("Invalid run state");
    }

    if (state.pendingQuestion.role === "architect" && state.phase !== "architecting") {
      throw new Error("Invalid run state");
    }

    if (state.pendingQuestion.role === "planner" && state.phase !== "planning") {
      throw new Error("Invalid run state");
    }

    if (state.pendingQuestion.role === "developer" && state.phase !== "developing") {
      throw new Error("Invalid run state");
    }

    if (state.pendingQuestion.role === "reviewer" && state.phase !== "reviewing") {
      throw new Error("Invalid run state");
    }
  }

  const activeChunk = state.chunks.find((chunk) => chunk.id === state.activeChunkId);

  if (state.activeChunkId === undefined) {
    if (state.phase === "developing" || state.phase === "reviewing" || state.phase === "escalated") {
      throw new Error("Invalid run state");
    }

    return;
  }

  if (!activeChunk) {
    throw new Error("Invalid run state");
  }

  if (
    (state.phase === "developing" && activeChunk.status !== "developing") ||
    (state.phase === "reviewing" && activeChunk.status !== "reviewing") ||
    (state.phase === "escalated" && activeChunk.status !== "escalated") ||
    (state.phase !== "developing" && state.phase !== "reviewing" && state.phase !== "escalated")
  ) {
    throw new Error("Invalid run state");
  }
};

export class ArtifactStore {
  private constructor(
    private readonly workspace: string,
    private readonly runId: string,
  ) {}

  static async create(workspace: string, runId: string, initial: RunState): Promise<ArtifactStore> {
    const store = new ArtifactStore(workspace, safeRunId(runId));

    validateInitialIdentity(workspace, runId, initial);

    await store.writeJson(stateFileName, initial);

    return store;
  }

  static async open(workspace: string, runId: string): Promise<ArtifactStore> {
    return new ArtifactStore(workspace, safeRunId(runId));
  }

  async writeText(name: string, content: string): Promise<void> {
    await atomicWrite(artifactPath(this.workspace, this.runId, name), content);
  }

  async readText(name: string): Promise<string> {
    return readFile(artifactPath(this.workspace, this.runId, name), "utf8");
  }

  async listFiles(name: string): Promise<ReadonlyArray<string>> {
    return (await readdir(artifactPath(this.workspace, this.runId, name), { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await this.writeText(name, JSON.stringify(value));
  }

  async appendTransition(transition: Transition, next: RunState): Promise<void> {
    validateLoadedState(this.workspace, this.runId, next);
    await appendJsonLine(artifactPath(this.workspace, this.runId, transitionsFileName), { transition, next });
    await this.writeJson(stateFileName, next);
  }

  async loadState(): Promise<RunState> {
    const state = parseState(JSON.parse(await this.readText(stateFileName)));

    validateLoadedState(this.workspace, this.runId, state);

    return state;
  }
}
