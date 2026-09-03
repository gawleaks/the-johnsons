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

export interface AcceptanceCriterion {
  readonly id: string;
  readonly text: string;
}

export interface ChunkDefinition {
  readonly id: string;
  readonly scope: string;
  readonly nonGoals: ReadonlyArray<string>;
  readonly prerequisites: ReadonlyArray<string>;
  readonly touchedAreas: ReadonlyArray<string>;
  readonly acceptanceCriteria: ReadonlyArray<AcceptanceCriterion>;
  readonly requiredChecks: ReadonlyArray<string>;
  readonly handoffArtifacts: ReadonlyArray<string>;
  readonly recoveryNotes: ReadonlyArray<string>;
}

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

export type PendingQuestion =
  | {
    readonly role: Role;
    readonly question: string;
    readonly handoff: string;
    readonly index: number;
    readonly status?: "pending";
  }
  | {
    readonly role: Role;
    readonly question: string;
    readonly handoff: string;
    readonly index: number;
    readonly status: "answered";
    readonly answer: string;
  };

export interface RunState {
  readonly version: 1;
  readonly runId: string;
  readonly workspace: string;
  readonly phase: RunPhase;
  readonly chunks: ReadonlyArray<ChunkState>;
  readonly activeChunkId?: string;
  readonly pendingQuestion?: PendingQuestion;
  readonly transitionId: number;
}

export type Transition =
  | { readonly type: "dispatching"; readonly role: Role }
  | { readonly type: "specification-created" }
  | { readonly type: "specification-approved" }
  | { readonly type: "plan-created"; readonly chunks: ReadonlyArray<ChunkState> }
  | { readonly type: "question-asked"; readonly role: Role; readonly question: string; readonly handoff: string; readonly index: number }
  | { readonly type: "question-answered"; readonly answer: string }
  | { readonly type: "developer-finished"; readonly deviated?: boolean }
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
