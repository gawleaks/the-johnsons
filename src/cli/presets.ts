import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWrite } from "../storage/files.js";
import { defaultPolicy, validatePolicy, type Policy, type RoleConfig, type ThinkingLevel } from "../policy/config.js";

export interface PresetStore {
  list(workspace: string): Promise<Readonly<Record<string, Policy>>>;
  save(workspace: string, name: string, policy: Policy): Promise<void>;
}

const presetFilePath = (workspace: string): string => join(resolve(workspace), ".johnsons", "presets.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPathLikeName = (name: string): boolean =>
  name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\\");

const policyKeys = ["maxReviewAttempts", "checkpointMode", "roles", "requiredChecks"] as const;
const roleNames = ["architect", "planner", "developer", "reviewer"] as const;
const roleKeys = ["model", "thinking", "tools", "timeoutMs"] as const;
const checkpointModes = new Set<Policy["checkpointMode"]>(["metadata", "git"]);
const thinkingLevels = new Set<ThinkingLevel>(["off", "low", "medium", "high", "max"]);

const hasExactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const parseStringList = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Invalid preset policy");
  }

  return value;
};

const parseRoleConfig = (value: unknown): RoleConfig => {
  if (!isRecord(value) || !hasExactKeys(value, roleKeys)) {
    throw new Error("Invalid preset policy");
  }

  if (typeof value.model !== "string" || !thinkingLevels.has(value.thinking as ThinkingLevel)) {
    throw new Error("Invalid preset policy");
  }

  if (!Number.isInteger(value.timeoutMs)) {
    throw new Error("Invalid preset policy");
  }

  return {
    model: value.model,
    thinking: value.thinking as ThinkingLevel,
    tools: parseStringList(value.tools),
    timeoutMs: value.timeoutMs as number,
  };
};

const parseRoles = (value: unknown): Policy["roles"] => {
  if (!isRecord(value) || !hasExactKeys(value, roleNames)) {
    throw new Error("Invalid preset policy");
  }

  return {
    architect: parseRoleConfig(value.architect),
    planner: parseRoleConfig(value.planner),
    developer: parseRoleConfig(value.developer),
    reviewer: parseRoleConfig(value.reviewer),
  };
};

const parsePolicy = (value: unknown): Policy => {
  if (!isRecord(value) || !hasExactKeys(value, policyKeys)) {
    throw new Error("Invalid preset policy");
  }

  if (!Number.isInteger(value.maxReviewAttempts) || !checkpointModes.has(value.checkpointMode as Policy["checkpointMode"])) {
    throw new Error("Invalid preset policy");
  }

  return validatePolicy({
    maxReviewAttempts: value.maxReviewAttempts as number,
    checkpointMode: value.checkpointMode as Policy["checkpointMode"],
    roles: parseRoles(value.roles),
    requiredChecks: parseStringList(value.requiredChecks),
  });
};

const loadPersistedPresets = async (workspace: string): Promise<Record<string, Policy>> => {
  const content = await readFile(presetFilePath(workspace), "utf8");
  const parsed = JSON.parse(content);

  if (!isRecord(parsed)) {
    throw new Error("Invalid preset file");
  }

  return Object.fromEntries(Object.entries(parsed).map(([name, value]) => [name, parsePolicy(value)]));
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
    const next = { ...presets, [name]: parsePolicy(policy) };

    await atomicWrite(presetFilePath(workspace), JSON.stringify(next));
  }
}
