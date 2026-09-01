import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { defaultPolicy, rolePrompts, type RoleConfig } from "../../src/policy/config.js";
import type { Role } from "../../src/domain/types.js";
import type { AgentProcess, AgentProcessResult, PiRpcAgentProcessOptions } from "../../src/rpc/agent-process.js";
import {
  PiRoleAgent,
  createAgentProcessFactory,
  loadAvailableModels,
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

describe("createAgentProcessFactory", () => {
  it("wires each role to its own session directory and optional cwd", () => {
    const created: PiRpcAgentProcessOptions[] = [];
    class FakeProcess implements AgentProcess {
      constructor(options: PiRpcAgentProcessOptions) {
        created.push(options);
      }

      async start(): Promise<void> { return undefined; }
      async prompt(): Promise<AgentProcessResult> { return result([]); }
      async abort(): Promise<void> { return undefined; }
      async close(): Promise<void> { return undefined; }
    }

    const factory = createAgentProcessFactory(
      "/tmp/session-root",
      "/tmp/prepared-workspace",
      "johnsons",
      FakeProcess as unknown as new (options: PiRpcAgentProcessOptions) => AgentProcess,
    );

    factory("architect", defaultPolicy.roles.architect);
    factory("reviewer", defaultPolicy.roles.reviewer);

    expect(created).toEqual([
      {
        sessionDir: "/tmp/session-root/architect",
        name: "johnsons-architect",
        model: defaultPolicy.roles.architect.model,
        timeoutMs: defaultPolicy.roles.architect.timeoutMs,
        cwd: "/tmp/prepared-workspace",
      },
      {
        sessionDir: "/tmp/session-root/reviewer",
        name: "johnsons-reviewer",
        model: defaultPolicy.roles.reviewer.model,
        timeoutMs: defaultPolicy.roles.reviewer.timeoutMs,
        cwd: "/tmp/prepared-workspace",
      },
    ]);
  });
});

describe("loadAvailableModels", () => {
  const createChild = () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    let killedWith: NodeJS.Signals | undefined;

    return {
      child: {
        stdout,
        stderr,
        stdin,
        kill: (signal?: NodeJS.Signals) => {
          killedWith = signal;
          return true;
        },
        on: stdout.on.bind(stdout),
        off: stdout.off.bind(stdout),
        once: stdout.once.bind(stdout),
      } as unknown as import("node:child_process").ChildProcessWithoutNullStreams,
      stdout,
      stderr,
      stdin,
      killedWith: () => killedWith,
    };
  };

  it("loads provider/id strings from the catalog response", async () => {
    const fake = createChild();
    const modelsPromise = loadAvailableModels("openai/gpt-5.6-sol", {
      mkdtemp: async () => "/tmp/catalog",
      rm: async () => undefined,
      spawn: () => fake.child,
    });

    fake.stdout.write('{"type":"response","id":"catalog","models":[{"provider":"openai","id":"gpt-5.6-sol"},{"provider":"anthropic","id":"sonnet-5"}]}' + "\n");

    await expect(modelsPromise).resolves.toEqual(["openai/gpt-5.6-sol", "anthropic/sonnet-5"]);
    expect(fake.stdin.read()?.toString("utf8")).toContain('"type":"get_available_models"');
    expect(fake.killedWith()).toBe("SIGTERM");
  });

  it("uses a generic failure message when pi exits early", async () => {
    const fake = createChild();
    const modelsPromise = loadAvailableModels("openai/gpt-5.6-sol", {
      mkdtemp: async () => "/tmp/catalog",
      rm: async () => undefined,
      spawn: () => fake.child,
    });

    await Promise.resolve();
    fake.stderr.write("token=secret\n");
    fake.stdout.emit("exit", 1);

    await expect(modelsPromise).rejects.toThrow(/failed to load model catalog/i);
    await expect(modelsPromise).rejects.not.toThrow(/token=secret/i);
  });

  it("rejects invalid catalog payloads", async () => {
    const fake = createChild();
    const modelsPromise = loadAvailableModels("openai/gpt-5.6-sol", {
      mkdtemp: async () => "/tmp/catalog",
      rm: async () => undefined,
      spawn: () => fake.child,
    });

    fake.stdout.write('{"type":"response","id":"catalog","models":[{"provider":"openai"}]}' + "\n");

    await expect(modelsPromise).rejects.toThrow(/invalid model catalog response/i);
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
