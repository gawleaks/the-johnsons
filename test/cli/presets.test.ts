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

describe("PresetStore", () => {
  it("returns the default preset when the file is absent", async () => {
    await withTempDir(async (workspace) => {
      await expect(store().list(workspace)).resolves.toEqual({ default: defaultPolicy });
    });
  });

  it("loads an existing empty preset file as empty", async () => {
    await withTempDir(async (workspace) => {
      await mkdir(join(workspace, ".johnsons"), { recursive: true });
      await writeFile(presetPath(workspace), "{}", "utf8");

      await expect(store().list(workspace)).resolves.toEqual({});
    });
  });

  it("saves and reloads presets atomically", async () => {
    await withTempDir(async (workspace) => {
      const presets = store();
      const saved = policy();

      await presets.save(workspace, "fast", saved);

      await expect(readFile(presetPath(workspace), "utf8")).resolves.toBe(JSON.stringify({ fast: saved }));
      await expect(presets.list(workspace)).resolves.toEqual({ fast: saved });
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
