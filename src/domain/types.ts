export type Role = "architect" | "planner" | "developer" | "reviewer";

export type RunPhase =
  | "architecting"
  | "awaiting-spec-approval"
  | "planning"
  | "developing"
  | "reviewing"
  | "escalated"
  | "completed"
  | "failed";

export type ReviewVerdict = "approved" | "rejected" | "escalate";

export interface ChunkState {
  readonly id: string;
  readonly status:
    | "pending"
    | "developing"
    | "reviewing"
    | "approved"
    | "escalated";
  readonly reviewAttempts: number;
}

export interface RunState {
  readonly version: 1;
  readonly runId: string;
  readonly workspace: string;
  readonly phase: RunPhase;
  readonly chunks: ReadonlyArray<ChunkState>;
  readonly activeChunkId?: string;
  readonly transitionId: number;
}

export type Transition =
  | { readonly type: "specification-created" }
  | { readonly type: "specification-approved" }
  | { readonly type: "plan-created"; readonly chunks: ReadonlyArray<ChunkState> }
  | { readonly type: "developer-finished" }
  | { readonly type: "reviewed"; readonly verdict: ReviewVerdict }
  | { readonly type: "user-escalated-resolution"; readonly resume: boolean };

export const createRunState = (runId: string, workspace: string): RunState =>
  Object.freeze({
    version: 1 as const,
    runId,
    workspace,
    phase: "architecting" as const,
    chunks: Object.freeze([]) as ReadonlyArray<ChunkState>,
    transitionId: 0,
  });
