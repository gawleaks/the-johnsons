import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonLine, atomicWrite, safeRelativePath } from "./files.js";
import type { ChunkState, RunState, Transition } from "../domain/types.js";

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
    transitionId: value.transitionId,
  };
};

const runRoot = (workspace: string, runId: string): string => join(workspace, ".johnsons", "runs", runId);

const artifactPath = (workspace: string, runId: string, name: string): string =>
  safeRelativePath(runRoot(workspace, runId), name);

export class ArtifactStore {
  private constructor(
    private readonly workspace: string,
    private readonly runId: string,
  ) {}

  static async create(workspace: string, runId: string, initial: RunState): Promise<ArtifactStore> {
    const store = new ArtifactStore(workspace, runId);

    await store.writeJson(stateFileName, initial);

    return store;
  }

  async writeText(name: string, content: string): Promise<void> {
    await atomicWrite(artifactPath(this.workspace, this.runId, name), content);
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await this.writeText(name, JSON.stringify(value));
  }

  async appendTransition(transition: Transition, next: RunState): Promise<void> {
    await appendJsonLine(artifactPath(this.workspace, this.runId, transitionsFileName), { transition, next });
    await this.writeJson(stateFileName, next);
  }

  async loadState(): Promise<RunState> {
    const content = await readFile(artifactPath(this.workspace, this.runId, stateFileName), "utf8");

    return parseState(JSON.parse(content));
  }
}
