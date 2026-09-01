import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { createRunState, type Role, type RunState } from "../src/domain/types.js";
import { defaultPolicy, type Policy } from "../src/policy/config.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import type { TerminalIo } from "../src/ui/terminal.js";

const tempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "johnsons-cli-"));

const withTempDir = async <T>(run: (workspace: string) => Promise<T>): Promise<T> => {
  const workspace = await tempDir();

  try {
    return await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

const runRoot = (workspace: string, runId: string): string => join(workspace, ".johnsons", "runs", runId);
const policyPath = (workspace: string, runId: string): string => join(runRoot(workspace, runId), "policy.json");
const statePath = (workspace: string, runId: string): string => join(runRoot(workspace, runId), "state.json");

const writeState = async (workspace: string, runId: string, state: RunState): Promise<void> => {
  await mkdir(runRoot(workspace, runId), { recursive: true });
  await writeFile(statePath(workspace, runId), JSON.stringify(state), "utf8");
};

const createIo = (preset = "default"): TerminalIo & { readonly lines: string[] } => {
  const lines: string[] = [];

  return {
    lines,
    choose: async () => preset,
    confirm: async () => true,
    ask: async () => "",
    write: (line) => {
      lines.push(line);
    },
  };
};

type MainDependencies = Parameters<typeof main>[1];

const createDependencies = (workspace: string, overrides: Partial<MainDependencies> = {}): MainDependencies & {
  readonly io: TerminalIo & { readonly lines: string[] };
  readonly roleAgent: { close(): Promise<void>; readonly closed: () => number };
} => {
  const io = createIo();
  let closes = 0;
  const roleAgent = {
    async prompt(): Promise<string> {
      return "";
    },
    async close(): Promise<void> {
      closes += 1;
    },
    closed: () => closes,
  };

  return {
    env: {},
    stderr: { write: () => true },
    randomUUID: () => "run-1",
    createTerminalIo: () => io,
    presetStore: {
      list: async () => ({ default: defaultPolicy }),
    },
    loadAvailableModels: async () => [
      defaultPolicy.roles.architect.model,
      defaultPolicy.roles.planner.model,
      defaultPolicy.roles.developer.model,
      defaultPolicy.roles.reviewer.model,
    ],
    workspaceManager: {
      prepare: async () => workspace,
    },
    createRoleAgent: () => roleAgent,
    createRunController: ({ artifactStore, policy }) => ({
      start: async () => {
        await expect(readFile(policyPath(workspace, "run-1"), "utf8")).resolves.toBe(JSON.stringify(policy));
        await expect(artifactStore.loadState()).resolves.toEqual(createRunState("run-1", workspace));
        return createRunState("run-1", workspace);
      },
      resume: async () => createRunState("run-1", workspace),
    }),
    io,
    roleAgent,
    ...overrides,
  };
};

describe("main", () => {
  it("starts a run after policy confirmation and persists its selected policy", async () => {
    await withTempDir(async (workspace) => {
      const dependencies = createDependencies(workspace);

      await expect(main(["start", "--workspace", workspace], dependencies)).resolves.toBe(0);
      await expect(readFile(policyPath(workspace, "run-1"), "utf8")).resolves.toBe(JSON.stringify(defaultPolicy));
      expect(dependencies.roleAgent.closed()).toBe(1);
    });
  });

  it("uses root-owned artifacts with prepared git cwd for start and resume", async () => {
    await withTempDir(async (workspace) => {
      const preparedWorkspace = join(workspace, ".johnsons", "worktrees", "run-1");
      let mode: Policy["checkpointMode"] | undefined;
      let stateWorkspace: string | undefined;
      const roleCalls: Array<{ workspace: string; executionWorkspace: string }> = [];
      const gitPolicy: Policy = { ...defaultPolicy, checkpointMode: "git" };

      const dependencies = createDependencies(workspace, {
        createTerminalIo: () => ({
          choose: async () => "git",
          confirm: async () => true,
          ask: async () => "",
          write: () => undefined,
        }),
        presetStore: {
          list: async () => ({ git: gitPolicy }),
        },
        loadAvailableModels: async () => [
          gitPolicy.roles.architect.model,
          gitPolicy.roles.planner.model,
          gitPolicy.roles.developer.model,
          gitPolicy.roles.reviewer.model,
        ],
        workspaceManager: {
          setMode: (nextMode) => {
            mode = nextMode;
          },
          prepare: async () => preparedWorkspace,
        },
        createRoleAgent: (_policy, _runId, runWorkspace, executionWorkspace) => {
          roleCalls.push({ workspace: runWorkspace, executionWorkspace });

          return {
            async prompt(): Promise<string> {
              return "";
            },
            async close(): Promise<void> {
              return;
            },
          };
        },
        createRunController: ({ artifactStore, policy }) => ({
          start: async () => {
            const state = await artifactStore.loadState();
            stateWorkspace = state.workspace;
            await expect(readFile(policyPath(workspace, "run-1"), "utf8")).resolves.toBe(JSON.stringify(policy));
            return state;
          },
          resume: async () => createRunState("run-1", preparedWorkspace),
        }),
      });

      await expect(main(["start", "--workspace", workspace, "--preset", "git"], dependencies)).resolves.toBe(0);
      expect(mode).toBe("git");
      expect(stateWorkspace).toBe(preparedWorkspace);
      expect(roleCalls).toEqual([{ workspace, executionWorkspace: preparedWorkspace }]);

      await expect(main(["resume", "run-1", "--workspace", workspace], dependencies)).resolves.toBe(0);
      expect(roleCalls).toEqual([
        { workspace, executionWorkspace: preparedWorkspace },
        { workspace, executionWorkspace: preparedWorkspace },
      ]);
    });
  });

  it("resumes an existing run with its persisted policy rather than current defaults", async () => {
    await withTempDir(async (workspace) => {
      const persistedPolicy: Policy = {
        ...defaultPolicy,
        roles: {
          ...defaultPolicy.roles,
          architect: {
            ...defaultPolicy.roles.architect,
            model: "moonshot/kimi-k2.8",
          },
        },
      };
      const store = await ArtifactStore.create(workspace, "run-1", createRunState("run-1", workspace));
      await store.writeJson("policy.json", persistedPolicy);
      const createdPolicies: Policy[] = [];
      const roleWorkspaces: string[] = [];
      const dependencies = createDependencies(workspace, {
        presetStore: {
          list: async () => ({ default: defaultPolicy }),
        },
        loadAvailableModels: async () => [
          persistedPolicy.roles.architect.model,
          persistedPolicy.roles.planner.model,
          persistedPolicy.roles.developer.model,
          persistedPolicy.roles.reviewer.model,
        ],
        createRoleAgent: (_policy, _runId, runWorkspace, executionWorkspace) => {
          roleWorkspaces.push(`${runWorkspace} -> ${executionWorkspace}`);
          return {
            async prompt(): Promise<string> { return ""; },
            async close(): Promise<void> { return; },
          };
        },
        createRunController: ({ policy }) => {
          createdPolicies.push(policy);
          return {
            start: async () => createRunState("run-1", workspace),
            resume: async () => createRunState("run-1", workspace),
          };
        },
      });

      await expect(main(["resume", "run-1", "--workspace", workspace], dependencies)).resolves.toBe(0);
      expect(createdPolicies).toEqual([persistedPolicy]);
      expect(roleWorkspaces).toEqual([`${workspace} -> ${workspace}`]);
      expect(dependencies.roleAgent.closed()).toBe(0);
    });
  });

  it("validates persisted resume models before creating a role agent", async () => {
    await withTempDir(async (workspace) => {
      const policy: Policy = {
        ...defaultPolicy,
        roles: {
          ...defaultPolicy.roles,
          reviewer: { ...defaultPolicy.roles.reviewer, model: "missing/model" },
        },
      };
      const store = await ArtifactStore.create(workspace, "run-1", createRunState("run-1", workspace));
      await store.writeJson("policy.json", policy);
      let agents = 0;
      const dependencies = createDependencies(workspace, {
        loadAvailableModels: async () => [],
        createRoleAgent: () => {
          agents += 1;
          return {
            async prompt(): Promise<string> { return ""; },
            async close(): Promise<void> { return; },
          };
        },
      });

      await expect(main(["resume", "run-1", "--workspace", workspace], dependencies)).resolves.toBe(2);
      expect(agents).toBe(0);
    });
  });

  it("closes the role agent when resume fails", async () => {
    await withTempDir(async (workspace) => {
      const store = await ArtifactStore.create(workspace, "run-1", createRunState("run-1", workspace));
      await store.writeJson("policy.json", defaultPolicy);
      let closes = 0;
      const dependencies = createDependencies(workspace, {
        createRoleAgent: () => ({
          async prompt(): Promise<string> {
            return "";
          },
          async close(): Promise<void> {
            closes += 1;
          },
        }),
        createRunController: () => ({
          start: async () => createRunState("run-1", workspace),
          resume: async () => {
            throw new Error("resume failed");
          },
        }),
      });

      await expect(main(["resume", "run-1", "--workspace", workspace], dependencies)).resolves.toBe(1);
      expect(closes).toBe(1);
    });
  });

  it("lists durable run ids and phases in lexical order", async () => {
    await withTempDir(async (workspace) => {
      await writeState(workspace, "run-2", { ...createRunState("run-2", workspace), phase: "planning" });
      await writeState(workspace, "run-1", { ...createRunState("run-1", workspace), phase: "completed" });
      const dependencies = createDependencies(workspace);

      await expect(main(["runs", "--workspace", workspace], dependencies)).resolves.toBe(0);
      expect(dependencies.io.lines).toEqual(["run-1\tcompleted", "run-2\tplanning"]);
    });
  });

  it("returns success and prints nothing when no runs exist", async () => {
    await withTempDir(async (workspace) => {
      const dependencies = createDependencies(workspace);

      await expect(main(["runs", "--workspace", workspace], dependencies)).resolves.toBe(0);
      expect(dependencies.io.lines).toEqual([]);
    });
  });

  it("returns 1 when model catalog loading fails", async () => {
    await withTempDir(async (workspace) => {
      const dependencies = createDependencies(workspace, {
        loadAvailableModels: async () => { throw new Error("catalog unavailable"); },
      });

      await expect(main(["start", "--workspace", workspace], dependencies)).resolves.toBe(1);
    });
  });

  it("validates the model catalog before preparing the workspace", async () => {
    await withTempDir(async (workspace) => {
      let prepareCalls = 0;
      const errors: string[] = [];
      const dependencies = createDependencies(workspace, {
        loadAvailableModels: async () => [],
        workspaceManager: {
          prepare: async () => {
            prepareCalls += 1;
            return workspace;
          },
        },
        stderr: {
          write: (chunk) => {
            errors.push(chunk);
            return true;
          },
        },
      });

      await expect(main(["start", "--workspace", workspace], dependencies)).resolves.toBe(2);
      expect(prepareCalls).toBe(0);
      expect(errors.join("")).toMatch(/unavailable models/i);
    });
  });

  it("returns 2 for validation errors", async () => {
    await withTempDir(async (workspace) => {
      const errors: string[] = [];
      const dependencies = createDependencies(workspace, {
        stderr: {
          write: (chunk) => {
            errors.push(chunk);
            return true;
          },
        },
      });

      await expect(main(["resume", "..", "--workspace", workspace], dependencies)).resolves.toBe(2);
      expect(errors.join("")).toMatch(/invalid run id/i);
    });
  });

  it("returns 1 for unexpected errors and prints stacks only in debug mode", async () => {
    await withTempDir(async (workspace) => {
      const plainErrors: string[] = [];
      const debugErrors: string[] = [];
      const failure = new Error("boom");
      failure.stack = "Error: boom\n  at line";

      const plain = createDependencies(workspace, {
        stderr: {
          write: (chunk) => {
            plainErrors.push(chunk);
            return true;
          },
        },
        createRunController: () => ({
          start: async () => { throw failure; },
          resume: async () => createRunState("run-1", workspace),
        }),
      });

      await expect(main(["start", "--workspace", workspace], plain)).resolves.toBe(1);
      expect(plainErrors.join("")).toContain("boom");
      expect(plainErrors.join("")).not.toContain("at line");

      const debug = createDependencies(workspace, {
        env: { JOHNSONS_DEBUG: "1" },
        stderr: {
          write: (chunk) => {
            debugErrors.push(chunk);
            return true;
          },
        },
        createRunController: () => ({
          start: async () => { throw failure; },
          resume: async () => createRunState("run-1", workspace),
        }),
      });

      await expect(main(["start", "--workspace", workspace], debug)).resolves.toBe(1);
      expect(debugErrors.join("")).toContain("at line");
    });
  });
});
