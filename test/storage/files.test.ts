import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { appendJsonLine, atomicWrite, safeRelativePath } from "../../src/storage/files.js";

const tempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "johnsons-files-"));

const withTempDir = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await tempDir();

  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("atomicWrite", () => {
  it("overwrites an existing file", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "artifact.txt");

      await atomicWrite(path, "first");
      await atomicWrite(path, "second");

      await expect(readFile(path, "utf8")).resolves.toBe("second");
    });
  });

  it("creates nested parent directories", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "nested", "deeper", "artifact.txt");

      await atomicWrite(path, "content");

      await expect(readFile(path, "utf8")).resolves.toBe("content");
    });
  });
});

describe("safeRelativePath", () => {
  it("rejects absolute paths and traversal", () => {
    expect(() => safeRelativePath("/workspace", "/etc/passwd")).toThrow();
    expect(() => safeRelativePath("/workspace", "../secrets.json")).toThrow();
  });
});

describe("appendJsonLine", () => {
  it("writes exactly one JSONL record per append", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "events.jsonl");

      await appendJsonLine(path, { id: 1 });
      await appendJsonLine(path, { id: 2 });

      const lines = (await readFile(path, "utf8")).trimEnd().split("\n");

      expect(lines).toHaveLength(2);
      expect(lines.map((line) => JSON.parse(line))).toEqual([{ id: 1 }, { id: 2 }]);
    });
  });
});
