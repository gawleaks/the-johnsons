import type { ChunkState, PendingQuestion, RunState, Transition } from "./types.js";

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

const freezeChunks = (chunks: ReadonlyArray<ChunkState>): ReadonlyArray<ChunkState> =>
  Object.freeze(chunks.map((chunk) => Object.freeze({ ...chunk })));

const freezePendingQuestion = (pendingQuestion: PendingQuestion): PendingQuestion =>
  Object.freeze({ ...pendingQuestion });

const freezeState = (state: RunState): RunState => {
  const next = {
    ...state,
    chunks: freezeChunks(state.chunks),
  } as RunState & { pendingQuestion?: PendingQuestion };

  if (state.pendingQuestion !== undefined) {
    next.pendingQuestion = freezePendingQuestion(state.pendingQuestion);
  }

  return Object.freeze(next);
};

type RunStateUpdates = Omit<Partial<RunState>, "activeChunkId" | "pendingQuestion"> & {
  readonly activeChunkId?: RunState["activeChunkId"] | undefined;
  readonly pendingQuestion?: RunState["pendingQuestion"] | undefined;
};

const nextState = (state: RunState, updates: RunStateUpdates): RunState => {
  const next = { ...state, ...updates, transitionId: state.transitionId + 1 } as RunState & {
    activeChunkId?: RunState["activeChunkId"];
    pendingQuestion?: RunState["pendingQuestion"];
  };

  if (Object.prototype.hasOwnProperty.call(updates, "activeChunkId") && updates.activeChunkId === undefined) {
    delete next.activeChunkId;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "pendingQuestion") && updates.pendingQuestion === undefined) {
    delete next.pendingQuestion;
  }

  return freezeState(next);
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

const withAnsweredPendingQuestionCleared = (state: RunState, updates: RunStateUpdates): RunStateUpdates =>
  state.pendingQuestion?.status === "answered"
    ? { ...updates, pendingQuestion: undefined }
    : updates;

export function applyTransition(
  state: RunState,
  transition: Transition,
  policy: { maxReviewAttempts: number },
): RunState {
  if (transition.type === "dispatching") {
    return nextState(state, {});
  }

  if (transition.type === "specification-created" && state.phase === "architecting") {
    return nextState(state, withAnsweredPendingQuestionCleared(state, { phase: "awaiting-spec-approval" }));
  }

  if (transition.type === "specification-approved" && state.phase === "awaiting-spec-approval") {
    return nextState(state, { phase: "planning" });
  }

  if (transition.type === "plan-created" && state.phase === "planning") {
    if (transition.chunks.length === 0) {
      throw new WorkflowError("Planning requires at least one chunk");
    }

    return nextState(state, withAnsweredPendingQuestionCleared(state, {
      phase: "developing",
      activeChunkId: transition.chunks[0]?.id,
      chunks: startChunks(transition.chunks),
    }));
  }

  if (
    transition.type === "question-asked"
    && ["architecting", "planning", "developing", "reviewing"].includes(state.phase)
    && (state.pendingQuestion === undefined || state.pendingQuestion.status === "answered")
  ) {
    return nextState(state, {
      pendingQuestion: {
        role: transition.role,
        question: transition.question,
        handoff: transition.handoff,
        index: transition.index,
        status: "pending",
      },
    });
  }

  if (transition.type === "question-answered" && state.pendingQuestion !== undefined) {
    return nextState(state, {
      pendingQuestion: {
        ...state.pendingQuestion,
        status: "answered",
        answer: transition.answer,
      },
    });
  }

  if (transition.type === "developer-finished" && state.phase === "developing") {
    const activeChunk = findActiveChunk(state);

    if (transition.deviated) {
      return nextState(state, withAnsweredPendingQuestionCleared(state, {
        phase: "escalated",
        chunks: replaceChunk(state, activeChunk.id, (chunk) => ({ ...chunk, status: "escalated" })),
      }));
    }

    return nextState(state, withAnsweredPendingQuestionCleared(state, {
      phase: "reviewing",
      chunks: replaceChunk(state, activeChunk.id, (chunk) => ({ ...chunk, status: "reviewing" })),
    }));
  }

  if (transition.type === "reviewed" && state.phase === "reviewing") {
    const activeChunk = findActiveChunk(state);

    if (transition.verdict === "escalate") {
      return nextState(state, withAnsweredPendingQuestionCleared(state, { phase: "escalated", chunks: escalateActiveChunk(state) }));
    }

    if (transition.verdict === "rejected") {
      const attempts = activeChunk.reviewAttempts + 1;
      const phase = attempts >= policy.maxReviewAttempts ? "escalated" : "developing";
      const status = attempts >= policy.maxReviewAttempts ? "escalated" : "developing";

      return nextState(state, withAnsweredPendingQuestionCleared(state, {
        phase,
        chunks: replaceChunk(state, activeChunk.id, (chunk) => ({
          ...chunk,
          reviewAttempts: attempts,
          status,
        })),
      }));
    }

    const approvedChunks = replaceChunk(state, activeChunk.id, (chunk) => ({ ...chunk, status: "approved" }));
    const next = activateNextChunk(approvedChunks, activeChunk.id);

    return nextState(state, withAnsweredPendingQuestionCleared(state, next));
  }

  if (transition.type === "user-escalated-resolution" && state.phase === "escalated") {
    if (!transition.resume) {
      return nextState(state, withAnsweredPendingQuestionCleared(state, { phase: "failed", activeChunkId: undefined }));
    }

    const activeChunk = findActiveChunk(state);

    return nextState(state, withAnsweredPendingQuestionCleared(state, {
      phase: "developing",
      chunks: replaceChunk(state, activeChunk.id, (chunk) => ({ ...chunk, status: "developing" })),
    }));
  }

  throw new WorkflowError(`Invalid transition ${transition.type} from ${state.phase}`);
}
