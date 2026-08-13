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
    "Verify the chunk independently and return a structured JSON verdict with findings and checks.",
    "Use only read-only, non-mutating behavior.",
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
