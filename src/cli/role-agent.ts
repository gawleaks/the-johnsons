import { mkdtemp, rm } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Buffer } from "node:buffer";
import type { Role } from "../domain/types.js";
import type { RoleAgent } from "../orchestrator/run-controller.js";
import { defaultPolicy, rolePrompts, type Policy, type RoleConfig } from "../policy/config.js";
import type { AgentProcess, AgentProcessResult, RpcEvent } from "../rpc/agent-process.js";
import { PiRpcAgentProcess } from "../rpc/agent-process.js";
import { JsonlDecoder } from "../rpc/jsonl.js";

export type AgentProcessFactory = (role: Role, config: RoleConfig) => AgentProcess;
export type ModelCatalogLoader = () => Promise<ReadonlyArray<string>>;
type AgentProcessConstructor = new (options: ConstructorParameters<typeof PiRpcAgentProcess>[0]) => AgentProcess;
type ModelCatalogDependencies = {
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly rm: (path: string, options: { readonly recursive: boolean; readonly force: boolean }) => Promise<void>;
  readonly spawn: (...args: any[]) => ChildProcessWithoutNullStreams;
};

const roles = ["architect", "planner", "developer", "reviewer"] as const;

const promptText = (role: Role, handoff: string): string =>
  handoff === "" ? rolePrompts[role] : `${rolePrompts[role]}\n\n---\n\n${handoff}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAssistantMessage = (value: unknown): value is { readonly role: "assistant"; readonly content: string } =>
  isRecord(value) && value.role === "assistant" && typeof value.content === "string";

const assistantText = (messages: ReadonlyArray<unknown>): string | undefined =>
  [...messages].reverse().find(isAssistantMessage)?.content;

const availableModels = (event: RpcEvent): ReadonlyArray<string> | undefined => {
  if (event.type !== "response" || event.id !== "catalog" || event.success === false || !Array.isArray(event.models)) {
    return undefined;
  }

  if (event.models.some((model) => !isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string")) {
    throw new Error("Invalid model catalog response");
  }

  return event.models.map((model) => `${model.provider}/${model.id}`);
};

export const validateModels = (policy: Policy, modelCatalog: ReadonlyArray<string>): void => {
  const catalog = new Set(modelCatalog);
  const missing = roles
    .map((role) => policy.roles[role].model)
    .filter((model, index, values) => !catalog.has(model) && values.indexOf(model) === index);

  if (missing.length > 0) {
    throw new Error(`Unavailable models: ${missing.join(", ")}`);
  }
};

export const createAgentProcessFactory = (
  sessionDir: string,
  name = "the-johnsons",
  Process: AgentProcessConstructor = PiRpcAgentProcess,
): AgentProcessFactory =>
  (role, config) =>
    new Process({
      sessionDir: join(sessionDir, role),
      name: `${name}-${role}`,
      model: config.model,
      timeoutMs: config.timeoutMs,
    });

const defaultModelCatalogDependencies: ModelCatalogDependencies = { mkdtemp, rm, spawn };

export const loadAvailableModels = async (
  model = defaultPolicy.roles.architect.model,
  dependencies = defaultModelCatalogDependencies,
): Promise<ReadonlyArray<string>> => {
  const sessionDir = await dependencies.mkdtemp(join(tmpdir(), "the-johnsons-models-"));
  const child = dependencies.spawn(
    "pi",
    ["--mode", "rpc", "--session-dir", sessionDir, "--name", "model-catalog", "--model", model],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const decoder = new JsonlDecoder();

  try {
    const models = await new Promise<ReadonlyArray<string>>((resolve, reject) => {
      let stderr = "";
      let done = false;
      const finish = (error?: Error, result?: ReadonlyArray<string>): void => {
        if (done) return;
        done = true;
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) {
          reject(error);
          return;
        }
        resolve(result ?? []);
      };
      const onStdout = (chunk: Buffer | string): void => {
        try {
          for (const record of decoder.push(chunk)) {
            const models = availableModels(record as RpcEvent);

            if (models) {
              finish(undefined, models);
              child.kill("SIGTERM");
              return;
            }
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const onStderr = (chunk: Buffer | string): void => {
        stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      };
      const onError = (error: Error): void => {
        finish(error);
      };
      const onExit = (): void => {
        finish(new Error("Failed to load model catalog"));
      };

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("error", onError);
      child.once("exit", onExit);
      child.stdin.write('{"id":"catalog","type":"get_available_models"}\n');
    });

    return models;
  } finally {
    child.kill("SIGTERM");
    await dependencies.rm(sessionDir, { recursive: true, force: true });
  }
};

export class PiRoleAgent implements RoleAgent {
  private readonly processes = new Map<Role, AgentProcess>();

  constructor(
    private readonly configs: Record<Role, RoleConfig>,
    private readonly factory: AgentProcessFactory,
  ) {}

  async prompt(role: Role, handoff: string): Promise<string> {
    const process = this.processes.get(role) ?? this.create(role);
    const result = await process.prompt(promptText(role, handoff));
    const text = this.extract(result);

    if (text === undefined) {
      throw new Error(`Missing assistant text for ${role}`);
    }

    return text;
  }

  async close(): Promise<void> {
    await Promise.all([...this.processes.values()].map((process) => process.close()));
    this.processes.clear();
  }

  private create(role: Role): AgentProcess {
    const process = this.factory(role, this.configs[role]);
    this.processes.set(role, process);
    return process;
  }

  private extract(result: AgentProcessResult): string | undefined {
    return assistantText(result.messages);
  }
}
