import type { Role } from "../domain/types.js";

export interface RoleHandoffArtifacts {
  readonly specification?: string;
  readonly plan?: string;
  readonly chunk?: string;
  readonly review?: string;
  readonly developerReviewReasoning?: string;
}

const promptLines = (lines: ReadonlyArray<string>): string => lines.join("\n");

export const rolePrompts: Record<Role, string> = {
  architect: promptLines([
    "You are the architect.",
    "Produce a concise Markdown specification with clear scope, constraints, and open questions.",
    "Capture only durable artifacts; do not provide hidden reasoning.",
  ]),
  planner: promptLines([
    "You are the planner.",
    "Produce a structured Markdown plan with ordered chunks, acceptance criteria, required checks, and handoff artifacts.",
    "Summarize the final handoff as JSON when needed.",
    "Keep the output deterministic and compact.",
  ]),
  developer: promptLines([
    "You are the developer.",
    "Implement exactly one active chunk and return a structured JSON or Markdown implementation report.",
    "If there is any plan deviation, stop and escalate immediately.",
  ]),
  reviewer: promptLines([
    "You are the reviewer.",
    "Verify the chunk independently and return exactly this JSON schema:",
    '{"verdict":"approved | rejected | escalate","summary":"...","findings":[{"severity":"blocker | major | minor","location":"path:line","problem":"...","requiredFix":"..."}],"acceptanceCriteria":[{"id":"AC-1","status":"pass | fail"}],"checks":[{"command":"...","status":"pass | fail","evidence":"..."}]}',
    "Use only read-only, non-mutating behavior.",
    "Only return approved when findings contain no blocker or major entries, every chunk acceptance criterion id appears exactly once with status pass, and every required check command appears exactly once with status pass.",
  ]),
};

const defined = (value: string | undefined): value is string => value !== undefined;

export const buildRoleHandoff = (
  role: Role,
  artifacts: RoleHandoffArtifacts,
): string => {
  const values = [
    artifacts.specification,
    artifacts.plan,
    artifacts.chunk,
    artifacts.review,
    role === "reviewer" ? undefined : artifacts.developerReviewReasoning,
  ];

  return values.filter(defined).join("\n\n---\n\n");
};
