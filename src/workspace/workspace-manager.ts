import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface CommandAdapter {
  run(
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
  ): Promise<{ readonly stdout: string; readonly exitCode: number }>;
}

export class ExternalWorkspaceChange extends Error {
  constructor(readonly workspace: string) {
    super(`External workspace changed: ${workspace}`);
    this.name = "ExternalWorkspaceChange";
  }
}

type WorkspaceMode = "metadata" | "git";

export interface WorkspaceManagerOptions {
  readonly mode: WorkspaceMode;
  readonly commandAdapter?: CommandAdapter;
}

type Snapshot = Record<string, string>;

const ignoredDirectories = new Set([".johnsons", "node_modules", ".git", "dist"]);

const isIgnoredDirectory = (name: string): boolean => ignoredDirectories.has(name);

const safeRunId = (runId: string): string => {
  if (runId.length === 0 || runId === "." || runId === ".." || runId.includes("/") || runId.includes("\\")) {
    throw new Error(`Invalid run id: ${runId}`);
  }

  return runId;
};

const hashFile = async (path: string): Promise<string> =>
  createHash("sha256").update(await readFile(path)).digest("hex");

const collectFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(root, { withFileTypes: true });

  return (
    await Promise.all(
      entries.flatMap((entry) => {
        if (entry.isDirectory()) {
          if (isIgnoredDirectory(entry.name)) {
            return [];
          }

          return [collectFiles(join(root, entry.name))];
        }

        return entry.isFile() ? [Promise.resolve([join(root, entry.name)])] : [];
      }),
    )
  ).flat();
};

const snapshotEntries = (snapshot: Snapshot): ReadonlyArray<readonly [string, string]> =>
  Object.entries(snapshot).sort(([left], [right]) => left.localeCompare(right));

const snapshotsEqual = (left: Snapshot, right: Snapshot): boolean =>
  JSON.stringify(snapshotEntries(left)) === JSON.stringify(snapshotEntries(right));

export class WorkspaceManager {
  constructor(private readonly options: WorkspaceManagerOptions) {}

  async prepare(workspace: string, runId: string): Promise<string> {
    const resolvedWorkspace = resolve(workspace);

    if (this.options.mode === "metadata") {
      return resolvedWorkspace;
    }

    const worktreePath = join(resolvedWorkspace, ".johnsons", "worktrees", safeRunId(runId));
    const adapter = this.options.commandAdapter;

    if (!adapter) {
      throw new Error("Missing command adapter");
    }

    const result = await adapter.run("git", ["worktree", "add", "--detach", worktreePath], resolvedWorkspace);

    if (result.exitCode !== 0) {
      throw new Error(result.stdout || "worktree creation failed");
    }

    return worktreePath;
  }

  async captureSnapshot(path: string): Promise<Snapshot> {
    const root = resolve(path);
    const files = (await collectFiles(root)).map((file) => relative(root, file)).sort();
    const hashes = await Promise.all(files.map(async (file) => [file, await hashFile(join(root, file))] as const));

    return Object.fromEntries(hashes);
  }

  async assertUnchanged(before: Snapshot, path: string): Promise<void> {
    const current = await this.captureSnapshot(path);

    if (!snapshotsEqual(before, current)) {
      throw new ExternalWorkspaceChange(path);
    }
  }
}
