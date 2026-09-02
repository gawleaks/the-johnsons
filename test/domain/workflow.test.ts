import { describe, expect, it } from "vitest";
import { createRunState, type ChunkState, type RunState } from "../../src/domain/types.js";
import { applyTransition, WorkflowError } from "../../src/domain/workflow.js";

const policy = { maxReviewAttempts: 2 };

const chunk = (id: string, overrides: Partial<ChunkState> = {}): ChunkState => ({
  id,
  status: "pending",
  reviewAttempts: 0,
  ...overrides,
});

const withState = (overrides: Partial<RunState>): RunState => ({
  ...createRunState("run-1", "/repo"),
  ...overrides,
});

const stateReviewingChunk = (): RunState =>
  withState({
    phase: "reviewing",
    activeChunkId: "chunk-1",
    chunks: [chunk("chunk-1", { status: "reviewing", reviewAttempts: 0 })],
  });

describe("applyTransition", () => {
  it("stores a pending question without changing the current phase", () => {
    const state = withState({
      phase: "developing",
      activeChunkId: "chunk-1",
      chunks: [chunk("chunk-1", { status: "developing" })],
    });

    const next = applyTransition(
      state,
      { type: "question-asked", role: "developer", question: "Need detail?", handoff: "# Spec\n\n---\n\nchunk", index: 1 },
      policy,
    );

    expect(next.phase).toBe("developing");
    expect(next.pendingQuestion).toEqual({
      role: "developer",
      question: "Need detail?",
      handoff: "# Spec\n\n---\n\nchunk",
      index: 1,
      status: "pending",
    });
  });

  it("marks a pending question answered without clearing it", () => {
    const state = withState({
      phase: "developing",
      activeChunkId: "chunk-1",
      chunks: [chunk("chunk-1", { status: "developing" })],
      pendingQuestion: {
        role: "developer",
        question: "Need detail?",
        handoff: "# Spec\n\n---\n\nchunk",
        index: 1,
        status: "pending",
      },
    });

    const next = applyTransition(state, { type: "question-answered", answer: "Use the small path" }, policy);

    expect(next.phase).toBe("developing");
    expect(next.pendingQuestion).toEqual({
      role: "developer",
      question: "Need detail?",
      handoff: "# Spec\n\n---\n\nchunk",
      index: 1,
      status: "answered",
      answer: "Use the small path",
    });
  });

  it("clears an answered pending question in the next successful transition", () => {
    const state = withState({
      phase: "developing",
      activeChunkId: "chunk-1",
      chunks: [chunk("chunk-1", { status: "developing" })],
      pendingQuestion: {
        role: "developer",
        question: "Need detail?",
        handoff: "# Spec\n\n---\n\nchunk",
        index: 1,
        status: "answered",
        answer: "Use the small path",
      },
    });

    const next = applyTransition(state, { type: "developer-finished", deviated: false }, policy);

    expect(next.phase).toBe("reviewing");
    expect(next.pendingQuestion).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(next, "pendingQuestion")).toBe(false);
  });

  it("requires explicit specification approval before planning", () => {
    const state = withState({ phase: "awaiting-spec-approval" });

    expect(() =>
      applyTransition(state, { type: "plan-created", chunks: [chunk("chunk-1")] }, policy),
    ).toThrow(/specification approval|Invalid transition/);

    expect(applyTransition(state, { type: "specification-approved" }, policy).phase).toBe("planning");
  });

  it("does not complete a chunk before reviewer approval", () => {
    expect(() =>
      applyTransition(stateReviewingChunk(), { type: "developer-finished" }, policy),
    ).toThrow(/reviewer approval|Invalid transition/);
  });

  it("moves the first planned chunk into development", () => {
    const state = withState({ phase: "planning" });

    const next = applyTransition(
      state,
      { type: "plan-created", chunks: [chunk("chunk-1"), chunk("chunk-2")] },
      policy,
    );

    expect(next.phase).toBe("developing");
    expect(next.activeChunkId).toBe("chunk-1");
    expect(next.chunks[0]?.status).toBe("developing");
    expect(next.chunks[1]?.status).toBe("pending");
    expect(next.transitionId).toBe(state.transitionId + 1);
  });

  it("moves a developed chunk into review", () => {
    const state = withState({
      phase: "developing",
      activeChunkId: "chunk-1",
      chunks: [chunk("chunk-1", { status: "developing" })],
    });

    const next = applyTransition(state, { type: "developer-finished" }, policy);

    expect(next.phase).toBe("reviewing");
    expect(next.chunks[0]?.status).toBe("reviewing");
  });

  it("escalates immediately on developer plan deviation", () => {
    const state = withState({
      phase: "developing",
      activeChunkId: "chunk-1",
      chunks: [chunk("chunk-1", { status: "developing" })],
    });

    const next = applyTransition(state, { type: "developer-finished", deviated: true }, policy);

    expect(next.phase).toBe("escalated");
    expect(next.chunks[0]?.status).toBe("escalated");
  });

  it("retries only the active chunk after reviewer rejection below the limit", () => {
    const state = withState({
      phase: "reviewing",
      activeChunkId: "chunk-2",
      chunks: [
        chunk("chunk-1", { status: "approved", reviewAttempts: 1 }),
        chunk("chunk-2", { status: "reviewing", reviewAttempts: 0 }),
      ],
    });

    const next = applyTransition(state, { type: "reviewed", verdict: "rejected" }, policy);

    expect(next.phase).toBe("developing");
    expect(next.activeChunkId).toBe("chunk-2");
    expect(next.chunks[0]).toEqual(state.chunks[0]);
    expect(next.chunks[1]).toMatchObject({ status: "developing", reviewAttempts: 1 });
  });

  it("escalates when reviewer rejection reaches the retry limit", () => {
    const state = withState({
      phase: "reviewing",
      activeChunkId: "chunk-1",
      chunks: [chunk("chunk-1", { status: "reviewing", reviewAttempts: 1 })],
    });

    const next = applyTransition(state, { type: "reviewed", verdict: "rejected" }, policy);

    expect(next.phase).toBe("escalated");
    expect(next.chunks[0]).toMatchObject({ status: "escalated", reviewAttempts: 2 });
  });

  it("escalates on reviewer escalation verdict", () => {
    const next = applyTransition(stateReviewingChunk(), { type: "reviewed", verdict: "escalate" }, policy);

    expect(next.phase).toBe("escalated");
    expect(next.chunks[0]?.status).toBe("escalated");
  });

  it("advances to the next chunk after reviewer approval", () => {
    const state = withState({
      phase: "reviewing",
      activeChunkId: "chunk-1",
      chunks: [
        chunk("chunk-1", { status: "reviewing", reviewAttempts: 1 }),
        chunk("chunk-2"),
      ],
    });

    const next = applyTransition(state, { type: "reviewed", verdict: "approved" }, policy);

    expect(next.phase).toBe("developing");
    expect(next.activeChunkId).toBe("chunk-2");
    expect(next.chunks[0]).toMatchObject({ status: "approved", reviewAttempts: 1 });
    expect(next.chunks[1]).toMatchObject({ status: "developing", reviewAttempts: 0 });
  });

  it("completes the run after the final reviewer approval", () => {
    const state = withState({
      phase: "reviewing",
      activeChunkId: "chunk-1",
      chunks: [chunk("chunk-1", { status: "reviewing", reviewAttempts: 0 })],
    });

    const next = applyTransition(state, { type: "reviewed", verdict: "approved" }, policy);

    expect(next.phase).toBe("completed");
    expect(next.activeChunkId).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(next, "activeChunkId")).toBe(false);
    expect(next.chunks[0]?.status).toBe("approved");
  });

  it("resumes escalated work on the same active chunk when the user chooses resume", () => {
    const state = withState({
      phase: "escalated",
      activeChunkId: "chunk-1",
      chunks: [chunk("chunk-1", { status: "escalated", reviewAttempts: 1 })],
    });

    const next = applyTransition(state, { type: "user-escalated-resolution", resume: true }, policy);

    expect(next.phase).toBe("developing");
    expect(next.chunks[0]).toMatchObject({ status: "developing", reviewAttempts: 1 });
  });

  it("fails escalated work when the user declines to resume", () => {
    const state = withState({
      phase: "escalated",
      activeChunkId: "chunk-1",
      chunks: [chunk("chunk-1", { status: "escalated", reviewAttempts: 2 })],
    });

    const next = applyTransition(state, { type: "user-escalated-resolution", resume: false }, policy);

    expect(next.phase).toBe("failed");
    expect(next.chunks[0]).toMatchObject({ status: "escalated", reviewAttempts: 2 });
  });

  it("throws a workflow error for invalid transitions", () => {
    expect(() => applyTransition(createRunState("run-1", "/repo"), { type: "reviewed", verdict: "approved" }, policy)).toThrow(
      WorkflowError,
    );
  });
});
