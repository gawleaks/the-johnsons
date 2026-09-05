#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID as createRandomUuid } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { parseCommand, type Command } from "./cli/arguments.js";
import { PresetStore } from "./cli/presets.js";
import { PiRoleAgent, createAgentProcessFactory, loadAvailableModels, validateModels } from "./cli/role-agent.js";
import { createRunState } from "./domain/types.js";
import { RunController, type RoleAgent, type RunControllerDeps } from "./orchestrator/run-controller.js";
import { validatePolicy, type Policy, type RoleConfig, type ThinkingLevel } from "./policy/config.js";
import { ArtifactStore } from "./storage/artifact-store.js";
import { TerminalRunUi, createTerminalIo, selectPolicy, type TerminalIo } from "./ui/terminal.js";
import { WorkspaceManager, type CommandAdapter } from "./workspace/workspace-manager.js";

const roles = ["architect", "planner", "developer", "reviewer"] as const;
const checkpointModes = new Set<Policy["checkpointMode"]>(["metadata", "git"]);
const thinkingLevels = new Set<ThinkingLevel>(["off", "low", "medium", "high", "max"]);
const policyKeys = ["maxReviewAttempts", "checkpointMode", "roles", "requiredChecks"] as const;
const localPolicyTemplate: Policy = {
  maxReviewAttempts: 2,
  checkpointMode: "metadata",
  roles: {
    architect: { model: "", thinking: "max", tools: ["read"], timeoutMs: 30_000 },
    planner: { model: "", thinking: "high", tools: ["read"], timeoutMs: 30_000 },
    developer: { model: "", thinking: "high", tools: ["read", "write", "bash"], timeoutMs: 30_000 },
    reviewer: { model: "", thinking: "high", tools: ["read", "ls"], timeoutMs: 30_000 },
  },
  requiredChecks: [],
};
const roleKeys = ["model", "thinking", "tools", "timeoutMs"] as const;

const policyPath = (workspace: string, runId: string): string =>
  join(workspace, ".johnsons", "runs", runId, "policy.json");

const runsRoot = (workspace: string): string => join(workspace, ".johnsons", "runs");
const statePath = (workspace: string, runId: string): string => join(runsRoot(workspace), runId, "state.json");

class ValidationError extends Error {
  readonly exitCode = 2;
}

class UnsupportedPiVersionError extends Error {}

const invalid = (message: string): ValidationError => new ValidationError(message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
  Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

const parseStringList = (value: unknown, message: string): ReadonlyArray<string> => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalid(message);
  }

  return value;
};

const parseRoleConfig = (value: unknown, message: string): RoleConfig => {
  if (!isRecord(value) || !hasExactKeys(value, roleKeys)) {
    throw invalid(message);
  }

  if (typeof value.model !== "string" || !thinkingLevels.has(value.thinking as ThinkingLevel) || !Number.isInteger(value.timeoutMs)) {
    throw invalid(message);
  }

  return {
    model: value.model,
    thinking: value.thinking as ThinkingLevel,
    tools: parseStringList(value.tools, message),
    timeoutMs: value.timeoutMs as number,
  };
};

const parsePolicyFile = (value: unknown): Policy => {
  const message = "Invalid policy.json";

  if (!isRecord(value) || !hasExactKeys(value, policyKeys)) {
    throw invalid(message);
  }

  if (!Number.isInteger(value.maxReviewAttempts) || !checkpointModes.has(value.checkpointMode as Policy["checkpointMode"])) {
    throw invalid(message);
  }

  if (!isRecord(value.roles) || !hasExactKeys(value.roles, roles)) {
    throw invalid(message);
  }

  return validatePolicy({
    maxReviewAttempts: value.maxReviewAttempts as number,
    checkpointMode: value.checkpointMode as Policy["checkpointMode"],
    roles: {
      architect: parseRoleConfig(value.roles.architect, message),
      planner: parseRoleConfig(value.roles.planner, message),
      developer: parseRoleConfig(value.roles.developer, message),
      reviewer: parseRoleConfig(value.roles.reviewer, message),
    },
    requiredChecks: parseStringList(value.requiredChecks, message),
  });
};

const loadPersistedPolicy = async (workspace: string, runId: string): Promise<Policy> => {
  try {
    return parsePolicyFile(JSON.parse(await readFile(policyPath(workspace, runId), "utf8")));
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }

    throw invalid(`Unable to load policy for run: ${runId}`);
  }
};

const narrowPreset = (presets: Readonly<Record<string, Policy>>, preset?: string): Readonly<Record<string, Policy>> => {
  if (preset === undefined) {
    return presets;
  }

  const policy = presets[preset];

  if (!policy) {
    throw invalid(`Unknown preset: ${preset}`);
  }

  return { [preset]: policy };
};

const printError = (stderr: Pick<Writable, "write">, env: NodeJS.ProcessEnv, error: unknown): void => {
  const message = error instanceof Error
    ? (env.JOHNSONS_DEBUG === "1" ? error.stack ?? error.message : error.message)
    : String(error);

  stderr.write(`${message}\n`);
};

const readRunSummary = async (workspace: string, runId: string): Promise<string> => {
  const state = JSON.parse(await readFile(statePath(workspace, runId), "utf8")) as { runId?: unknown; phase?: unknown };

  if (typeof state.runId !== "string" || typeof state.phase !== "string") {
    throw new Error(`Invalid run state: ${runId}`);
  }

  return `${state.runId}\t${state.phase}`;
};

const listRuns = async (workspace: string, io: Pick<TerminalIo, "write">): Promise<void> => {
  try {
    const entries = await readdir(runsRoot(workspace), { withFileTypes: true });
    const lines = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async ({ name }) => readRunSummary(workspace, name)),
    );

    lines.sort((left, right) => left.localeCompare(right)).forEach((line) => io.write(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }
};

const runCommand: CommandAdapter["run"] = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ stdout: output.trim(), exitCode: code ?? 1 });
    });
  });

const commandAdapter: CommandAdapter = { run: runCommand };
const supportedPiVersion = createRequire(import.meta.url)("../package.json").dependencies["@earendil-works/pi-coding-agent"] as string;

export const isCompatiblePiVersion = (expected: string, actual: string): boolean => {
  const parse = (version: string): ReadonlyArray<string> | undefined => version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)?.slice(1);
  const expectedParts = parse(expected);
  const actualParts = parse(actual);
  return expectedParts !== undefined && actualParts !== undefined && expectedParts[0] === actualParts[0] && expectedParts[1] === actualParts[1];
};

export const validatePiVersion = async (version = supportedPiVersion): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("pi", ["--version"], (error, stdout) => {
      if (error) return reject(new Error("Unable to validate Pi version"));
      return isCompatiblePiVersion(version, stdout.trim()) ? resolve() : reject(new UnsupportedPiVersionError(`Unsupported Pi version: ${stdout.trim()}`));
    });
  });

export const workspaceSafetyFor = (mode: Policy["checkpointMode"]) =>
  mode === "metadata"
    ? {
      capture: (workspace: string) => new WorkspaceManager({ mode: "metadata" }).captureSnapshot(workspace),
      assertUnchanged: (snapshot: unknown, workspace: string) =>
        new WorkspaceManager({ mode: "metadata" }).assertUnchanged(snapshot as Record<string, string>, workspace),
    }
    : undefined;

export interface MainDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly stderr: Pick<Writable, "write">;
  readonly randomUUID: () => string;
  readonly createTerminalIo: () => TerminalIo;
  readonly presetStore: { list(workspace: string): Promise<Readonly<Record<string, Policy>>>; save?(workspace: string, name: string, policy: Policy): Promise<void> }; 
  readonly loadAvailableModels: (model: string) => Promise<ReadonlyArray<string>>;
  readonly validatePiVersion: () => Promise<void>;
  readonly workspaceManager: {
    prepare(workspace: string, runId: string): Promise<string>;
    setMode?(mode: Policy["checkpointMode"]): void;
  };
  readonly createRoleAgent: (policy: Policy, runId: string, workspace: string, executionWorkspace: string) => RoleAgent & { close(): Promise<void> };
  readonly createRunController: (deps: RunControllerDeps) => Pick<RunController, "start" | "resume">;
}

export const createProductionDependencies = (): MainDependencies => {
  let mode: Policy["checkpointMode"] = "metadata";

  return {
    env: process.env,
    stderr: process.stderr,
    randomUUID: createRandomUuid,
    createTerminalIo,
    presetStore: new PresetStore(),
    loadAvailableModels,
    validatePiVersion,
    workspaceManager: {
      setMode: (nextMode) => {
        mode = nextMode;
      },
      prepare: (workspace, runId) => new WorkspaceManager({ mode, commandAdapter }).prepare(workspace, runId),
    },
    createRoleAgent: (policy, runId, workspace, executionWorkspace) => new PiRoleAgent(
      policy.roles,
      createAgentProcessFactory(join(workspace, ".johnsons", "runs", runId, "sessions"), executionWorkspace),
    ),
    createRunController: (deps) => {
      const workspaceSafety = workspaceSafetyFor(deps.policy.checkpointMode);

      return new RunController({
        ...deps,
        ...(workspaceSafety === undefined ? {} : { workspaceSafety }),
      });
    },
  };
};

const parseCliCommand = (argv: readonly string[]): Command => {
  try {
    return parseCommand(argv);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
};

const validatePiRuntime = async (operation: () => Promise<void>): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    if (error instanceof UnsupportedPiVersionError) throw invalid(error.message);
    throw error;
  }
};

const validateInput = async <T>(operation: () => Promise<T> | T): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
};

const configure = async (command: Extract<Command, { type: "config" }>, dependencies: MainDependencies): Promise<number> => {
  const io = dependencies.createTerminalIo();
  const { policy } = await validateInput(() => selectPolicy(io, { default: localPolicyTemplate }));
  await validateInput(() => {
    if (roles.some((role) => policy.roles[role].model.trim() === "")) throw new Error("A model is required for every role");
  });
  const save = dependencies.presetStore.save;
  if (save === undefined) throw new Error("Preset saving is unavailable");
  await validateInput(() => save(command.workspace, "default", validatePolicy(policy)));
  io.write(`Saved local preset: ${join(command.workspace, ".johnsons", "presets.json")}`);
  return 0;
};

const startRun = async (
  command: Extract<Command, { type: "start" }>,
  dependencies: MainDependencies,
): Promise<number> => {
  await validatePiRuntime(() => dependencies.validatePiVersion());
  const io = dependencies.createTerminalIo();
  const ui = new TerminalRunUi(io);
  const presets = await validateInput(() => dependencies.presetStore.list(command.workspace));
  const { policy } = await validateInput(() => selectPolicy(io, narrowPreset(presets, command.preset)));
  const validatedPolicy = await validateInput(() => validatePolicy(policy));

  const catalog = await dependencies.loadAvailableModels(validatedPolicy.roles.architect.model);
  await validateInput(() => validateModels(validatedPolicy, catalog));

  const runId = dependencies.randomUUID();
  dependencies.workspaceManager.setMode?.(validatedPolicy.checkpointMode);
  const preparedWorkspace = await dependencies.workspaceManager.prepare(command.workspace, runId);
  const artifactStore = await ArtifactStore.create(command.workspace, runId, createRunState(runId, preparedWorkspace));
  await artifactStore.writeJson("policy.json", validatedPolicy);
  const roleAgent = dependencies.createRoleAgent(validatedPolicy, runId, command.workspace, preparedWorkspace);

  try {
    await dependencies.createRunController({ artifactStore, policy: validatedPolicy, roleAgent, ui }).start();
    return 0;
  } finally {
    await roleAgent.close();
  }
};

const resumeRun = async (
  command: Extract<Command, { type: "resume" }>,
  dependencies: MainDependencies,
): Promise<number> => {
  await validatePiRuntime(() => dependencies.validatePiVersion());
  const artifactStore = await validateInput(() => ArtifactStore.open(command.workspace, command.runId));
  const policy = await loadPersistedPolicy(command.workspace, command.runId);
  const catalog = await dependencies.loadAvailableModels(policy.roles.architect.model);
  await validateInput(() => validateModels(policy, catalog));
  const state = await validateInput(() => artifactStore.loadState());
  const roleAgent = dependencies.createRoleAgent(policy, command.runId, command.workspace, state.workspace);
  const ui = new TerminalRunUi(dependencies.createTerminalIo());

  try {
    await dependencies.createRunController({ artifactStore, policy, roleAgent, ui }).resume();
    return 0;
  } finally {
    await roleAgent.close();
  }
};

export const main = async (argv: readonly string[], dependencies: MainDependencies): Promise<number> => {
  try {
    const command = parseCliCommand(argv);

    if (command.type === "config") return await configure(command, dependencies);

    if (command.type === "runs") {
      await listRuns(command.workspace, dependencies.createTerminalIo());
      return 0;
    }

    return command.type === "start"
      ? await startRun(command, dependencies)
      : await resumeRun(command, dependencies);
  } catch (error) {
    printError(dependencies.stderr, dependencies.env, error);
    return error instanceof ValidationError ? error.exitCode : 1;
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main(process.argv.slice(2), createProductionDependencies()).then((code) => {
    process.exitCode = code;
  });
}
