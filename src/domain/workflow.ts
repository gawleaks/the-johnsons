import type { ChunkState, RunState, Transition } from "./types.js";

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

const freezeChunks = (chunks: ReadonlyArray<ChunkState>): ReadonlyArray<ChunkState> =>
  Object.freeze(chunks.map((chunk) => Object.freeze({ ...chunk })));

const freezeState = (state: RunState): RunState =>
  Object.freeze({
    ...state,
    chunks: freezeChunks(state.chunks),
  });

type RunStateUpdates = Omit<Partial<RunState>, "activeChunkId"> & {
  readonly activeChunkId?: RunState["activeChunkId"] | undefined;
};

const nextState = (state: RunState, updates: RunStateUpdates): RunState => {
  const { activeChunkId, ...restUpdates } = updates;
  const hasActiveChunkIdUpdate = Object.prototype.hasOwnProperty.call(updates, "activeChunkId");

  if (!hasActiveChunkIdUpdate) {
    return freezeState({
      ...state,
      ...restUpdates,
      transitionId: state.transitionId + 1,
    });
  }

  if (activeChunkId === undefined) {
    const { activeChunkId: _currentActiveChunkId, ...stateWithoutActiveChunkId } = state;

    return freezeState({
      ...stateWithoutActiveChunkId,
      ...restUpdates,
      transitionId: state.transitionId + 1,
    });
  }

  return freezeState({
    ...state,
    ...restUpdates,
    activeChunkId,
    transitionId: state.transitionId + 1,
  });
};

const findActiveChunk = (state: RunState): ChunkState => {
  const activeChunk = state.chunks.find((chunk) => chunk.id === state.activeChunkId);

  if (!state.activeChunkId || !activeChunk) {
    throw new WorkflowError(`Missing active chunk for ${state.phase}`);
  }

  return activeChunk;
};

const replaceChunk = (
  state: RunState,
  chunkId: string,
  update: (chunk: ChunkState) => ChunkState,
): ReadonlyArray<ChunkState> => state.chunks.map((chunk) => (chunk.id === chunkId ? update(chunk) : chunk));

const startChunks = (chunks: ReadonlyArray<ChunkState>): RunState["chunks"] =>
  chunks.map((chunk, index) => ({
    ...chunk,
    status: index === 0 ? "developing" : "pending",
  }));

const activateNextChunk = (chunks: ReadonlyArray<ChunkState>, activeChunkId: string) => {
  const activeIndex = chunks.findIndex((chunk) => chunk.id === activeChunkId);
  const nextChunk = chunks.slice(activeIndex + 1).find((chunk) => chunk.status === "pending");

  if (!nextChunk) {
    return { chunks, activeChunkId: undefined, phase: "completed" as const };
  }

  return {
    activeChunkId: nextChunk.id,
    phase: "developing" as const,
    chunks: chunks.map((chunk) =>
      chunk.id === nextChunk.id ? { ...chunk, status: "developing" as const } : chunk,
    ),
  };
};

const escalateActiveChunk = (state: RunState): RunState["chunks"] =>
  replaceChunk(state, findActiveChunk(state).id, (chunk) => ({ ...chunk, status: "escalated" }));

export function applyTransition(
  state: RunState,
  transition: Transition,
  policy: { maxReviewAttempts: number },
): RunState {
  if (transition.type === "specification-created" && state.phase === "architecting") {
    return nextState(state, { phase: "awaiting-spec-approval" });
  }

  if (transition.type === "specification-approved" && state.phase === "awaiting-spec-approval") {
    return nextState(state, { phase: "planning" });
  }

  if (transition.type === "plan-created" && state.phase === "planning") {
    if (transition.chunks.length === 0) {
      throw new WorkflowError("Planning requires at least one chunk");
    }

    return nextState(state, {
      phase: "developing",
      activeChunkId: transition.chunks[0]?.id,
      chunks: startChunks(transition.chunks),
    });
  }

  if (transition.type === "developer-finished" && state.phase === "developing") {
    const activeChunk = findActiveChunk(state);

    if (transition.deviated) {
      return nextState(state, {
        phase: "escalated",
        chunks: replaceChunk(state, activeChunk.id, (chunk) => ({ ...chunk, status: "escalated" })),
      });
    }

    return nextState(state, {
      phase: "reviewing",
      chunks: replaceChunk(state, activeChunk.id, (chunk) => ({ ...chunk, status: "reviewing" })),
    });
  }

  if (transition.type === "reviewed" && state.phase === "reviewing") {
    const activeChunk = findActiveChunk(state);

    if (transition.verdict === "escalate") {
      return nextState(state, { phase: "escalated", chunks: escalateActiveChunk(state) });
    }

    if (transition.verdict === "rejected") {
      const attempts = activeChunk.reviewAttempts + 1;
      const phase = attempts >= policy.maxReviewAttempts ? "escalated" : "developing";
      const status = attempts >= policy.maxReviewAttempts ? "escalated" : "developing";

      return nextState(state, {
        phase,
        chunks: replaceChunk(state, activeChunk.id, (chunk) => ({
          ...chunk,
          reviewAttempts: attempts,
          status,
        })),
      });
    }

    const approvedChunks = replaceChunk(state, activeChunk.id, (chunk) => ({ ...chunk, status: "approved" }));
    const next = activateNextChunk(approvedChunks, activeChunk.id);

    return nextState(state, next);
  }

  if (transition.type === "user-escalated-resolution" && state.phase === "escalated") {
    if (!transition.resume) {
      return nextState(state, { phase: "failed" });
    }

    const activeChunk = findActiveChunk(state);

    return nextState(state, {
      phase: "developing",
      chunks: replaceChunk(state, activeChunk.id, (chunk) => ({ ...chunk, status: "developing" })),
    });
  }

  throw new WorkflowError(`Invalid transition ${transition.type} from ${state.phase}`);
}
