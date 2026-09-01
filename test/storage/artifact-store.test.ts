import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createRunState, type RunState } from "../../src/domain/types.js";
import { ArtifactStore } from "../../src/storage/artifact-store.js";

const tempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "johnsons-artifact-store-"));

const withTempDir = async <T>(run: (workspace: string) => Promise<T>): Promise<T> => {
  const workspace = await tempDir();

  try {
    return await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

const runRoot = (workspace: string, runId: string): string => join(workspace, ".johnsons", "runs", runId);
const statePath = (workspace: string, runId: string): string => join(runRoot(workspace, runId), "state.json");
const transitionsPath = (workspace: string, runId: string): string => join(runRoot(workspace, runId), "transitions.jsonl");

const nextState = (state: RunState): RunState => ({
  ...state,
  phase: "planning",
  transitionId: state.transitionId + 1,
});

describe("ArtifactStore", () => {
  it("writes state.json for a new run", async () => {
    await withTempDir(async (workspace) => {
      const initial = createRunState("run-1", workspace);

      const store = await ArtifactStore.create(workspace, "run-1", initial);

      await expect(readFile(statePath(workspace, "run-1"), "utf8")).resolves.toBe(JSON.stringify(initial));
      await expect(store.loadState()).resolves.toEqual(initial);
    });
  });

  it("appends transitions and reloads the latest state", async () => {
    await withTempDir(async (workspace) => {
      const initial = createRunState("run-1", workspace);
      const store = await ArtifactStore.create(workspace, "run-1", initial);
      const first = nextState(initial);
      const second = nextState(first);

      await store.appendTransition({ type: "specification-created" }, first);
      await store.appendTransition({ type: "specification-approved" }, second);

      const lines = (await readFile(transitionsPath(workspace, "run-1"), "utf8")).trimEnd().split("\n");

      expect(lines).toHaveLength(2);
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        { transition: { type: "specification-created" }, next: first },
        { transition: { type: "specification-approved" }, next: second },
      ]);
      await expect(store.loadState()).resolves.toEqual(second);
    });
  });

  it("opens an existing run store", async () => {
    await withTempDir(async (workspace) => {
      const initial = createRunState("run-1", workspace);
      await ArtifactStore.create(workspace, "run-1", initial);

      const reopened = await ArtifactStore.open(workspace, "run-1");

      await expect(reopened.loadState()).resolves.toEqual(initial);
    });
  });

  it("rejects run id traversal on create and open", async () => {
    await withTempDir(async (workspace) => {
      const initial = createRunState("../run-1", workspace);

      await expect(ArtifactStore.create(workspace, "../run-1", initial)).rejects.toThrow();
      await expect(ArtifactStore.open(workspace, "../run-1")).rejects.toThrow();
    });
  });

  it("stores artifacts separately from the execution workspace", async () => {
    await withTempDir(async (workspace) => {
      const initial = createRunState("run-1", `${workspace}/worktree`);
      const store = await ArtifactStore.create(workspace, "run-1", initial);

      await store.writeText("specification.md", "spec");
      await expect(store.loadState()).resolves.toEqual(initial);
      await expect(store.readText("specification.md")).resolves.toBe("spec");
    });
  });

  it("rejects semantically invalid state when the active chunk is missing", async () => {
    await withTempDir(async (workspace) => {
      const runId = "run-1";
      const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
      await writeFile(
        statePath(workspace, runId),
        JSON.stringify({
          ...createRunState(runId, workspace),
          phase: "developing",
          activeChunkId: "chunk-1",
          chunks: [],
        }),
        "utf8",
      );

      await expect(store.loadState()).rejects.toThrow();
    });
  });

  it("rejects semantically invalid state when the active chunk does not fit the phase", async () => {
    await withTempDir(async (workspace) => {
      const runId = "run-1";
      const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));
      await writeFile(
        statePath(workspace, runId),
        JSON.stringify({
          ...createRunState(runId, workspace),
          phase: "completed",
          activeChunkId: "chunk-1",
          chunks: [{ id: "chunk-1", status: "approved", reviewAttempts: 0 }],
        }),
        "utf8",
      );

      await expect(store.loadState()).rejects.toThrow();
    });
  });

  it("rejects artifact names that escape the run directory", async () => {
    await withTempDir(async (workspace) => {
      const store = await ArtifactStore.create(workspace, "run-1", createRunState("run-1", workspace));

      await expect(store.writeText("../escape.txt", "nope")).rejects.toThrow();
      await expect(store.writeJson("/etc/passwd", { nope: true })).rejects.toThrow();
    });
  });

  it("rejects invalid and non-v1 state", async () => {
    await withTempDir(async (workspace) => {
      const runId = "run-1";
      const store = await ArtifactStore.create(workspace, runId, createRunState(runId, workspace));

      await writeFile(statePath(workspace, runId), JSON.stringify({ version: 2 }), "utf8");
      await expect(store.loadState()).rejects.toThrow();

      await writeFile(statePath(workspace, runId), JSON.stringify({ version: 1, runId }), "utf8");
      await expect(store.loadState()).rejects.toThrow();
    });
  });

  it("ignores a stray temporary file when reloading state", async () => {
    await withTempDir(async (workspace) => {
      const runId = "run-1";
      const initial = createRunState(runId, workspace);
      const store = await ArtifactStore.create(workspace, runId, initial);
      const tempPath = `${statePath(workspace, runId)}.12345.deadbeef.tmp`;

      await writeFile(tempPath, "corrupted", "utf8");

      await expect(store.loadState()).resolves.toEqual(initial);
    });
  });
});
