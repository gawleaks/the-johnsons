import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { defaultPolicy, validatePolicy, type Policy } from "../../src/policy/config.js";
import { PresetStore } from "../../src/cli/presets.js";

const tempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "johnsons-presets-"));

const withTempDir = async <T>(run: (workspace: string) => Promise<T>): Promise<T> => {
  const workspace = await tempDir();

  try {
    return await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

const store = () => new PresetStore();

const presetPath = (workspace: string): string => join(workspace, ".johnsons", "presets.json");

const policy = (): Policy =>
  validatePolicy({
    maxReviewAttempts: 2,
    checkpointMode: "metadata",
    roles: defaultPolicy.roles,
    requiredChecks: [],
  });

const withInheritedField = <T extends object>(value: T, inherited: Record<string, unknown>): T =>
  Object.assign(Object.create(inherited), value);

const invalidPolicies = {
  extraRootField: {
    ...defaultPolicy,
    apiKey: "secret-value",
  },
  extraRoleField: {
    ...defaultPolicy,
    roles: {
      ...defaultPolicy.roles,
      developer: {
        ...defaultPolicy.roles.developer,
        temperature: 0.2,
      },
    },
  },
  secretLookingField: {
    ...defaultPolicy,
    roles: {
      ...defaultPolicy.roles,
      reviewer: {
        ...defaultPolicy.roles.reviewer,
        providerToken: "shh",
      },
    },
  },
  invalidThinkingEnum: {
    ...defaultPolicy,
    roles: {
      ...defaultPolicy.roles,
      developer: {
        ...defaultPolicy.roles.developer,
        thinking: "ultra",
      },
    },
  },
  nonStringToolsEntry: {
    ...defaultPolicy,
    roles: {
      ...defaultPolicy.roles,
      developer: {
        ...defaultPolicy.roles.developer,
        tools: ["npm test", 1],
      },
    },
  },
  nonIntegerTimeoutMs: {
    ...defaultPolicy,
    roles: {
      ...defaultPolicy.roles,
      developer: {
        ...defaultPolicy.roles.developer,
        timeoutMs: 1.5,
      },
    },
  },
  missingRoleName: {
    ...defaultPolicy,
    roles: {
      architect: defaultPolicy.roles.architect,
      planner: defaultPolicy.roles.planner,
      developer: defaultPolicy.roles.developer,
    } as unknown as Policy["roles"],
  },
  extraRoleName: {
    ...defaultPolicy,
    roles: {
      ...defaultPolicy.roles,
      auditor: defaultPolicy.roles.reviewer,
    } as unknown as Policy["roles"],
  },
  malformedRoleName: {
    ...defaultPolicy,
    roles: {
      architect: defaultPolicy.roles.architect,
      planner: defaultPolicy.roles.planner,
      developer: defaultPolicy.roles.developer,
      "reviewer-v2": defaultPolicy.roles.reviewer,
    } as unknown as Policy["roles"],
  },
  wrongScalarType: {
    ...defaultPolicy,
    maxReviewAttempts: "2",
  },
  wrongListType: {
    ...defaultPolicy,
    requiredChecks: "npm test",
  },
} as const;

describe("PresetStore", () => {
  it("requires local configuration when the file is absent", async () => {
    await withTempDir(async (workspace) => {
      await expect(store().list(workspace)).rejects.toThrow(/config/i);
    });
  });

  it("requires local configuration when an existing preset file is empty", async () => {
    await withTempDir(async (workspace) => {
      await mkdir(join(workspace, ".johnsons"), { recursive: true });
      await writeFile(presetPath(workspace), "{}", "utf8");

      await expect(store().list(workspace)).rejects.toThrow(/config/i);
    });
  });

  it.each(["", ".", "..", "foo/bar", "foo\\backslash"])(
    "rejects persisted unsafe preset name %j",
    async (name) => {
      await withTempDir(async (workspace) => {
        await mkdir(join(workspace, ".johnsons"), { recursive: true });
        await writeFile(presetPath(workspace), JSON.stringify({ [name]: policy() }), "utf8");

        await expect(store().list(workspace)).rejects.toThrow(/preset/i);
      });
    },
  );

  it("saves and reloads presets atomically", async () => {
    await withTempDir(async (workspace) => {
      const presets = store();
      const saved = policy();

      await presets.save(workspace, "fast", saved);

      await expect(readFile(presetPath(workspace), "utf8")).resolves.toBe(JSON.stringify({ fast: saved }));
      await expect(presets.list(workspace)).resolves.toEqual({ fast: saved });
    });
  });

  it("rejects save input with inherited extra properties", async () => {
    await withTempDir(async (workspace) => {
      const inheritedFieldPolicy = withInheritedField(policy(), { apiKey: "secret-value" });

      await expect(store().save(workspace, "broken", inheritedFieldPolicy as Policy)).rejects.toThrow();
    });
  });

  it.each(Object.entries(invalidPolicies))("rejects persisted policy with %s", async (_name, invalidPolicy) => {
    await withTempDir(async (workspace) => {
      const presets = store();

      await mkdir(join(workspace, ".johnsons"), { recursive: true });
      await writeFile(presetPath(workspace), JSON.stringify({ broken: invalidPolicy }), "utf8");

      await expect(presets.list(workspace)).rejects.toThrow();
    });
  });

  it.each(Object.entries(invalidPolicies))("rejects save input with %s", async (_name, invalidPolicy) => {
    await withTempDir(async (workspace) => {
      await expect(store().save(workspace, "broken", invalidPolicy as Policy)).rejects.toThrow();
    });
  });

  it("round-trips defaultPolicy unchanged", async () => {
    await withTempDir(async (workspace) => {
      const presets = store();

      await presets.save(workspace, "default-copy", defaultPolicy);

      await expect(presets.list(workspace)).resolves.toEqual({ "default-copy": defaultPolicy });
    });
  });

  it("rejects malformed JSON and invalid policies", async () => {
    await withTempDir(async (workspace) => {
      const presets = store();

      await mkdir(join(workspace, ".johnsons"), { recursive: true });
      await writeFile(presetPath(workspace), "{", "utf8");
      await expect(presets.list(workspace)).rejects.toThrow();

      await writeFile(
        presetPath(workspace),
        JSON.stringify({ broken: { ...policy(), maxReviewAttempts: 0 } }),
        "utf8",
      );
      await expect(presets.list(workspace)).rejects.toThrow();

      await expect(presets.save(workspace, "bad", { ...policy(), maxReviewAttempts: 0 })).rejects.toThrow();
    });
  });

  it("rejects empty and path-like preset names", async () => {
    await withTempDir(async (workspace) => {
      const presets = store();

      await expect(presets.save(workspace, "", policy())).rejects.toThrow(/preset/i);
      await expect(presets.save(workspace, ".", policy())).rejects.toThrow(/preset/i);
      await expect(presets.save(workspace, "..", policy())).rejects.toThrow(/preset/i);
      await expect(presets.save(workspace, "foo/bar", policy())).rejects.toThrow(/preset/i);
      await expect(presets.save(workspace, "foo\\bar", policy())).rejects.toThrow(/preset/i);
    });
  });
});
