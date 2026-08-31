import { describe, expect, it } from "vitest";
import { defaultPolicy, rolePrompts, type RoleConfig } from "../../src/policy/config.js";
import type { Role } from "../../src/domain/types.js";
import type { AgentProcess, AgentProcessResult } from "../../src/rpc/agent-process.js";
import {
  PiRoleAgent,
  validateModels,
  type AgentProcessFactory,
} from "../../src/cli/role-agent.js";

const result = (messages: ReadonlyArray<unknown>): AgentProcessResult => ({
  messages,
  events: [],
  stderr: "",
});

const createProcess = (messages: ReadonlyArray<unknown>): AgentProcess & { readonly calls: string[]; closed: boolean } => {
  const calls: string[] = [];

  return {
    calls,
    closed: false,
    start: async () => undefined,
    prompt: async (message: string) => {
      calls.push(message);
      return result(messages);
    },
    abort: async () => undefined,
    close: async function () {
      this.closed = true;
    },
  };
};

describe("validateModels", () => {
  it("rejects a policy whose reviewer model is unavailable", () => {
    expect(() => validateModels(defaultPolicy, ["openai/gpt-5.6-sol"]))
      .toThrow(/anthropic\/sonnet-5/);
  });
});

describe("PiRoleAgent", () => {
  it("returns the final assistant text from the configured role process", async () => {
    const created: Array<{ role: Role; config: RoleConfig }> = [];
    const process = createProcess([{ role: "assistant", content: "{\"specification\":\"x\"}" }]);
    const roleAgent = new PiRoleAgent(
      {
        architect: defaultPolicy.roles.architect,
        planner: defaultPolicy.roles.planner,
        developer: defaultPolicy.roles.developer,
        reviewer: defaultPolicy.roles.reviewer,
      },
      ((role, config) => {
        created.push({ role, config });
        return process;
      }) satisfies AgentProcessFactory,
    );

    await expect(roleAgent.prompt("architect", "handoff")).resolves.toBe('{"specification":"x"}');
    await expect(roleAgent.prompt("architect", "handoff-2")).resolves.toBe('{"specification":"x"}');

    expect(created).toEqual([{ role: "architect", config: defaultPolicy.roles.architect }]);
    expect(process.calls).toHaveLength(2);
    expect(process.calls[0]).toContain(rolePrompts.architect);
    expect(process.calls[0]).toContain("handoff");
    expect(process.calls[1]).toContain("handoff-2");
  });

  it("closes each cached role process", async () => {
    const processes = new Map<Role, ReturnType<typeof createProcess>>();
    const factory: AgentProcessFactory = (role) => {
      const process = createProcess([{ role: "assistant", content: role }]);
      processes.set(role, process);
      return process;
    };
    const roleAgent = new PiRoleAgent(defaultPolicy.roles, factory);

    await roleAgent.prompt("architect", "a");
    await roleAgent.prompt("reviewer", "b");
    await roleAgent.close();

    expect(processes.get("architect")?.closed).toBe(true);
    expect(processes.get("reviewer")?.closed).toBe(true);
  });

  it("throws when no assistant text is present", async () => {
    const roleAgent = new PiRoleAgent(
      defaultPolicy.roles,
      () => createProcess([{ role: "user", content: "nope" }]),
    );

    await expect(roleAgent.prompt("planner", "handoff")).rejects.toThrow(/assistant/i);
  });
});
