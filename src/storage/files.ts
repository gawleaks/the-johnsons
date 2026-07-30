import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const fileMode = 0o600;

const ensureParentDirectory = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
};

export const safeRelativePath = (root: string, name: string): string => {
  if (isAbsolute(name)) {
    throw new Error(`Absolute paths are not allowed: ${name}`);
  }

  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, name);
  const pathWithinRoot = relative(resolvedRoot, resolvedPath);

  if (pathWithinRoot === "" || (!pathWithinRoot.startsWith("..") && !isAbsolute(pathWithinRoot))) {
    return resolvedPath;
  }

  throw new Error(`Path escapes root: ${name}`);
};

export const atomicWrite = async (path: string, content: string): Promise<void> => {
  await ensureParentDirectory(path);

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  await writeFile(temporaryPath, content, { mode: fileMode });
  await rename(temporaryPath, path);
};

export const appendJsonLine = async (path: string, value: unknown): Promise<void> => {
  await ensureParentDirectory(path);
  await appendFile(path, `${JSON.stringify(value)}\n`, { mode: fileMode });
};
