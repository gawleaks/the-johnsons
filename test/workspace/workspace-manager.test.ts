import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ExternalWorkspaceChange, WorkspaceManager, type CommandAdapter } from "../../src/workspace/workspace-manager.js";

const tempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "johnsons-workspace-manager-"));

const withTempDir = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await tempDir();

  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const fakeCommandAdapter = (): { adapter: CommandAdapter; calls: Array<{ command: string; args: ReadonlyArray<string>; cwd: string }> } => {
  const calls: Array<{ command: string; args: ReadonlyArray<string>; cwd: string }> = [];

  return {
    calls,
    adapter: {
      async run(command, args, cwd) {
        calls.push({ command, args, cwd });
        return { stdout: "", exitCode: 0 };
      },
    },
  };
};

describe("WorkspaceManager", () => {
  it("returns the resolved workspace in metadata mode without calling the adapter", async () => {
    await withTempDir(async (workspace) => {
      const { adapter, calls } = fakeCommandAdapter();
      const manager = new WorkspaceManager({ mode: "metadata", commandAdapter: adapter });

      await expect(manager.prepare(workspace, "run-1")).resolves.toBe(resolve(workspace));
      expect(calls).toHaveLength(0);
    });
  });

  it("creates a detached worktree through the injected adapter in git mode", async () => {
    await withTempDir(async (workspace) => {
      const { adapter, calls } = fakeCommandAdapter();
      const manager = new WorkspaceManager({ mode: "git", commandAdapter: adapter });

      await expect(manager.prepare(workspace, "run-1")).resolves.toBe(
        join(workspace, ".johnsons", "worktrees", "run-1"),
      );
      expect(calls).toEqual([
        {
          command: "git",
          args: ["worktree", "add", "--detach", join(workspace, ".johnsons", "worktrees", "run-1")],
          cwd: workspace,
        },
      ]);
    });
  });

  it("captures snapshots with deterministic hashes and skips ignored directories", async () => {
    await withTempDir(async (workspace) => {
      const manager = new WorkspaceManager({ mode: "metadata" });

      await mkdir(join(workspace, "dist", "nested"), { recursive: true });
      await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
      await mkdir(join(workspace, ".git"), { recursive: true });
      await mkdir(join(workspace, ".johnsons", "runs"), { recursive: true });
      await writeFile(join(workspace, "b.txt"), "two", "utf8");
      await writeFile(join(workspace, "a.txt"), "one", "utf8");
      await writeFile(join(workspace, "dist", "nested", "skip.txt"), "nope", "utf8");
      await writeFile(join(workspace, "node_modules", "pkg", "skip.txt"), "nope", "utf8");
      await writeFile(join(workspace, ".git", "skip.txt"), "nope", "utf8");
      await writeFile(join(workspace, ".johnsons", "runs", "skip.txt"), "nope", "utf8");

      await expect(manager.captureSnapshot(workspace)).resolves.toEqual({
        "a.txt": "7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed",
        "b.txt": "3fc4ccfe745870e2c0d99f71f30ff0656c8dedd41cc1d7d3d376b0dbe685e2f3",
      });
    });
  });

  it("rejects changed snapshots", async () => {
    await withTempDir(async (workspace) => {
      const manager = new WorkspaceManager({ mode: "metadata" });

      await writeFile(join(workspace, "state.txt"), "before", "utf8");
      const snapshot = await manager.captureSnapshot(workspace);
      await writeFile(join(workspace, "state.txt"), "after", "utf8");

      await expect(manager.assertUnchanged(snapshot, workspace)).rejects.toBeInstanceOf(
        ExternalWorkspaceChange,
      );
    });
  });
});
