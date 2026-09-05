import type { Role } from "../domain/types.js";
import { buildRoleHandoff, rolePrompts, type RoleHandoffArtifacts } from "./prompts.js";

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";

export interface RoleConfig {
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly tools: ReadonlyArray<string>;
  readonly timeoutMs: number;
}

export interface Policy {
  readonly maxReviewAttempts: number;
  readonly checkpointMode: "metadata" | "git";
  readonly roles: Record<Role, RoleConfig>;
  readonly requiredChecks: ReadonlyArray<string>;
}

const readonlyReviewTools = new Set(["edit", "write", "bash"]);

const createRoleConfig = (
  model: string,
  thinking: ThinkingLevel,
  tools: ReadonlyArray<string>,
): RoleConfig => ({
  model,
  thinking,
  tools,
  timeoutMs: 30_000,
});

const validateReviewerTools = (policy: Policy): void => {
  const forbidden = policy.roles.reviewer.tools.filter((tool) => readonlyReviewTools.has(tool));

  if (forbidden.length > 0) {
    throw new Error(`reviewer tools are not read-only: ${forbidden.join(", ")}`);
  }
};

export const defaultPolicy: Policy = {
  maxReviewAttempts: 2,
  checkpointMode: "metadata",
  roles: {
    architect: createRoleConfig("openai/gpt-5.6-sol", "max", ["read"]),
    planner: createRoleConfig("openai/gpt-5.6-terra", "high", ["read"]),
    developer: createRoleConfig("moonshot/kimi-k2.7", "high", ["read", "write", "bash"]),
    reviewer: createRoleConfig("anthropic/sonnet-5", "high", ["read", "ls"]),
  },
  requiredChecks: [],
};

export const validatePolicy = (policy: Policy): Policy => {
  if (!Number.isInteger(policy.maxReviewAttempts) || policy.maxReviewAttempts < 1) {
    throw new Error("maxReviewAttempts must be at least 1");
  }

  if (Object.values(policy.roles).some((role) => role.model.trim() === "")) {
    throw new Error("Every role requires a model");
  }

  validateReviewerTools(policy);
  return policy;
};

export { buildRoleHandoff, rolePrompts };
export type { RoleHandoffArtifacts };
