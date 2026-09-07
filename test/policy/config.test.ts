import { describe, expect, it } from "vitest";
import {
  buildRoleHandoff,
  defaultPolicy,
  validatePolicy,
  type Policy,
} from "../../src/policy/config.js";
import { rolePrompts } from "../../src/policy/prompts.js";

const reviewTools = (tools: ReadonlyArray<string>) => ({
  model: "anthropic/sonnet-5",
  thinking: "high" as const,
  tools,
  timeoutMs: 30_000,
});

const policy = (reviewerTools: ReadonlyArray<string> = ["read", "ls"]) : Policy => ({
  maxReviewAttempts: 2,
  checkpointMode: "metadata",
  roles: {
    architect: {
      model: "openai/gpt-5.6-sol",
      thinking: "max",
      tools: ["read"],
      timeoutMs: 30_000,
    },
    planner: {
      model: "openai/gpt-5.6-terra",
      thinking: "high",
      tools: ["read"],
      timeoutMs: 30_000,
    },
    developer: {
      model: "moonshot/kimi-k2.7",
      thinking: "high",
      tools: ["read", "write", "bash"],
      timeoutMs: 30_000,
    },
    reviewer: reviewTools(reviewerTools),
  },
  requiredChecks: ["npm test"],
});

describe("policy config", () => {
  it("ships the default role preset", () => {
    expect(defaultPolicy.roles.architect).toMatchObject({
      model: "openai/gpt-5.6-sol",
      thinking: "max",
    });
    expect(defaultPolicy.roles.planner).toMatchObject({
      model: "openai/gpt-5.6-terra",
      thinking: "high",
    });
    expect(defaultPolicy.roles.developer).toMatchObject({
      model: "moonshot/kimi-k2.7",
      thinking: "high",
    });
    expect(defaultPolicy.roles.reviewer).toMatchObject({
      model: "anthropic/sonnet-5",
      thinking: "high",
    });
  });

  it("rejects maxReviewAttempts below 1", () => {
    expect(() => validatePolicy({ ...policy(), maxReviewAttempts: 0 })).toThrow(
      "maxReviewAttempts must be at least 1",
    );
  });

  it("rejects blank role models", () => {
    expect(() => validatePolicy({
      ...policy(),
      roles: { ...policy().roles, architect: { ...policy().roles.architect, model: " " } },
    })).toThrow(/model/i);
  });

  it("rejects reviewer edit write and bash tools", () => {
    expect(() => validatePolicy(policy(["read", "edit"]))).toThrow(/reviewer/i);
    expect(() => validatePolicy(policy(["read", "write"]))).toThrow(/reviewer/i);
    expect(() => validatePolicy(policy(["read", "bash"]))).toThrow(/reviewer/i);
  });

  it("keeps reviewer handoffs free of developer reasoning", () => {
    const artifacts = {
      specification: "spec",
      plan: "plan",
      chunk: "chunk",
      review: "review",
      developerReviewReasoning: "hidden reasoning",
      answer: "user answer",
    };

    expect(buildRoleHandoff("reviewer", artifacts)).not.toContain("hidden reasoning");
    expect(buildRoleHandoff("reviewer", artifacts)).toContain("user answer");
    expect(buildRoleHandoff("developer", artifacts)).toContain("hidden reasoning");
    expect(buildRoleHandoff("developer", artifacts)).toContain("user answer");
  });

  it("requires structured artifacts and deviation escalation in the prompts", () => {
    expect(rolePrompts.architect).toContain('{"question"');
    expect(rolePrompts.architect).toContain('{"specification"');
    expect(rolePrompts.architect).toContain("Markdown");
    expect(rolePrompts.planner).toContain("JSON");
    expect(rolePrompts.developer).toContain("plan deviation");
    expect(rolePrompts.developer).toContain("escalate");
    expect(rolePrompts.reviewer).toContain('"verdict"');
    expect(rolePrompts.reviewer).toContain('"summary"');
    expect(rolePrompts.reviewer).toContain('"findings"');
    expect(rolePrompts.reviewer).toContain('"acceptanceCriteria"');
    expect(rolePrompts.reviewer).toContain('"checks"');
  });
});
