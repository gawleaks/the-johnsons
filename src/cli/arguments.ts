import { resolve } from "node:path";

export type Command =
  | { readonly type: "start"; readonly workspace: string; readonly preset?: string }
  | { readonly type: "resume"; readonly workspace: string; readonly runId: string }
  | { readonly type: "runs"; readonly workspace: string }
  | { readonly type: "config"; readonly workspace: string };

const supportedCommands = new Set(["start", "resume", "runs", "config"]);
const knownFlags = new Set(["--workspace", "--preset"]);
const supportedStartFlags = new Set(["--workspace", "--preset"]);
const supportedResumeFlags = new Set(["--workspace"]);
const supportedRunsFlags = new Set(["--workspace"]);
const supportedConfigFlags = new Set(["--workspace"]);
const pathLikeSegments = new Set(["", ".", ".."]);

const isFlag = (value: string): boolean => value.startsWith("--");

const isUnsafeRunId = (value: string): boolean =>
  value.length === 0 || pathLikeSegments.has(value) || value.includes("/") || value.includes("\\");

const readValue = (argv: readonly string[], index: number, flag: string): { readonly value: string; readonly nextIndex: number } => {
  const value = argv[index + 1];

  if (typeof value !== "string" || isFlag(value)) {
    throw new Error(`Missing value for ${flag}`);
  }

  return { value, nextIndex: index + 1 };
};

const parseOptions = (
  argv: readonly string[],
  allowedFlags: ReadonlySet<string>,
): { readonly workspace?: string; readonly preset?: string; readonly positional: ReadonlyArray<string> } => {
  const options: { workspace?: string; preset?: string } = {};
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (typeof token !== "string") {
      continue;
    }

    if (!isFlag(token)) {
      positional.push(token);
      continue;
    }

    if (!knownFlags.has(token)) {
      throw new Error(`Unknown flag: ${token}`);
    }

    if (!allowedFlags.has(token)) {
      throw new Error(`Incompatible flag: ${token}`);
    }

    if (token === "--workspace" && options.workspace !== undefined) {
      throw new Error(`Duplicate flag: ${token}`);
    }

    if (token === "--preset" && options.preset !== undefined) {
      throw new Error(`Duplicate flag: ${token}`);
    }

    const { value, nextIndex } = readValue(argv, index, token);

    if (token === "--workspace") {
      options.workspace = value;
    } else {
      options.preset = value;
    }

    index = nextIndex;
  }

  return { ...options, positional };
};

const resolveWorkspace = (workspace?: string): string => resolve(workspace ?? process.cwd());

const parseStart = (argv: readonly string[]): Command => {
  const parsed = parseOptions(argv, supportedStartFlags);

  const firstPositional = parsed.positional[0];

  if (firstPositional !== undefined) {
    throw new Error(`Incompatible argument: ${firstPositional}`);
  }

  return {
    type: "start",
    workspace: resolveWorkspace(parsed.workspace),
    ...(parsed.preset === undefined ? {} : { preset: parsed.preset }),
  };
};

const parseConfig = (argv: readonly string[]): Command => {
  const parsed = parseOptions(argv, supportedConfigFlags);
  if (parsed.positional[0] !== undefined) throw new Error(`Incompatible argument: ${parsed.positional[0]}`);
  return { type: "config", workspace: resolveWorkspace(parsed.workspace) };
};

const parseResume = (argv: readonly string[]): Command => {
  const firstPositionalIndex = argv.findIndex((token) => !isFlag(token));

  if (firstPositionalIndex > -1 && argv.slice(0, firstPositionalIndex).includes("--workspace")) {
    throw new Error("Argument order: --workspace must follow run id");
  }

  const parsed = parseOptions(argv, supportedResumeFlags);
  const runId = parsed.positional[0];
  const extraRunId = parsed.positional[1];

  if (runId === undefined) {
    throw new Error("Missing run id");
  }

  if (extraRunId !== undefined) {
    throw new Error(`Incompatible argument: ${extraRunId}`);
  }

  if (isUnsafeRunId(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }

  return {
    type: "resume",
    workspace: resolveWorkspace(parsed.workspace),
    runId,
  };
};

const parseRuns = (argv: readonly string[]): Command => {
  const parsed = parseOptions(argv, supportedRunsFlags);

  const firstPositional = parsed.positional[0];

  if (firstPositional !== undefined) {
    throw new Error(`Incompatible argument: ${firstPositional}`);
  }

  return {
    type: "runs",
    workspace: resolveWorkspace(parsed.workspace),
  };
};

export const parseCommand = (argv: readonly string[]): Command => {
  const [command, ...rest] = argv;

  if (!command || !supportedCommands.has(command)) {
    throw new Error(`Unknown command: ${command ?? ""}`);
  }

  if (command === "start") {
    return parseStart(rest);
  }

  if (command === "resume") {
    return parseResume(rest);
  }

  if (command === "config") {
    return parseConfig(rest);
  }

  return parseRuns(rest);
};
