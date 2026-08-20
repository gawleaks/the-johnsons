import type { Role } from "../../src/domain/types.js";

export interface FakeAgentCall {
  readonly role: Role;
  readonly handoff: string;
}

export const createFakeAgent = (
  responses: Partial<Record<Role, ReadonlyArray<string>>> = {},
) => {
  const calls: Array<FakeAgentCall> = [];
  const remaining = new Map<Role, Array<string>>(
    Object.entries(responses).map(([role, values]) => [role as Role, [...(values ?? [])]]),
  );

  return {
    calls,
    prompt: async (role: Role, handoff: string): Promise<string> => {
      calls.push({ role, handoff });
      const queue = remaining.get(role) ?? [];
      const next = queue.shift();
      remaining.set(role, queue);

      if (next === undefined) {
        throw new Error(`No fake response for ${role}`);
      }

      return next;
    },
  };
};
