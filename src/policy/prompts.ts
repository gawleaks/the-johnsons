import type { Role } from "../domain/types.js";

export interface RoleHandoffArtifacts {
  readonly specification?: string;
  readonly plan?: string;
  readonly chunk?: string;
  readonly review?: string;
  readonly developerReviewReasoning?: string;
  readonly answer?: string;
}

const promptLines = (lines: ReadonlyArray<string>): string => lines.join("\n");

export const rolePrompts: Record<Role, string> = {
  architect: promptLines([
    "You are the architect.",
    "If no task has been provided, return exactly JSON: {\"question\":\"What should I design?\"}.",
    "Otherwise return exactly JSON: {\"specification\":\"concise Markdown specification with scope, constraints, and open questions\"}.",
    "Return no prose or Markdown fences outside the JSON. Do not provide hidden reasoning.",
  ]),
  planner: promptLines([
    "You are the planner.",
    "Return exactly JSON with one key named chunks. Each chunk must contain exactly: id, scope, nonGoals, prerequisites, touchedAreas, acceptanceCriteria, requiredChecks, handoffArtifacts, recoveryNotes.",
    "acceptanceCriteria is a nonempty array of {\"id\":\"AC-1\",\"text\":\"...\"}; all other plural fields are string arrays.",
    "Return no prose or Markdown fences outside the JSON. Keep the output deterministic and compact.",
  ]),
  developer: promptLines([
    "You are the developer.",
    "Implement exactly one active chunk and return exactly JSON: {\"report\":\"Markdown implementation report\",\"deviated\":false}.",
    "If there is any plan deviation, stop and escalate by returning the same schema with deviated set to true.",
    "Return no prose or Markdown fences outside the JSON.",
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
    artifacts.answer,
  ];

  return values.filter(defined).join("\n\n---\n\n");
};
