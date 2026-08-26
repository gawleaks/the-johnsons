import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWrite } from "../storage/files.js";
import { defaultPolicy, validatePolicy, type Policy } from "../policy/config.js";

export interface PresetStore {
  list(workspace: string): Promise<Readonly<Record<string, Policy>>>;
  save(workspace: string, name: string, policy: Policy): Promise<void>;
}

const presetFilePath = (workspace: string): string => join(resolve(workspace), ".johnsons", "presets.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPathLikeName = (name: string): boolean =>
  name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\\");

const loadPersistedPresets = async (workspace: string): Promise<Record<string, Policy>> => {
  const content = await readFile(presetFilePath(workspace), "utf8");
  const parsed = JSON.parse(content);

  if (!isRecord(parsed)) {
    throw new Error("Invalid preset file");
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([name, value]) => [name, validatePolicy(value as Policy)]),
  );
};

const loadPersistedPresetsOrEmpty = async (workspace: string): Promise<Record<string, Policy>> => {
  try {
    return await loadPersistedPresets(workspace);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw error;
  }
};

export class PresetStore implements PresetStore {
  async list(workspace: string): Promise<Readonly<Record<string, Policy>>> {
    try {
      return await loadPersistedPresets(workspace);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return { default: defaultPolicy };
      }

      throw error;
    }
  }

  async save(workspace: string, name: string, policy: Policy): Promise<void> {
    if (isPathLikeName(name)) {
      throw new Error(`Invalid preset name: ${name}`);
    }

    const presets = await loadPersistedPresetsOrEmpty(workspace);
    const next = { ...presets, [name]: validatePolicy(policy) };

    await atomicWrite(presetFilePath(workspace), JSON.stringify(next));
  }
}
