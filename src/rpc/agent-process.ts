import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { JsonlDecoder } from "./jsonl.js";

export interface AgentProcessResult {
  readonly messages: ReadonlyArray<unknown>;
  readonly events: ReadonlyArray<RpcEvent>;
  readonly stderr: string;
}

export interface AgentProcess {
  start(): Promise<void>;
  prompt(message: string): Promise<AgentProcessResult>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface PiRpcAgentProcessOptions {
  readonly sessionDir: string;
  readonly name: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly abortGraceMs?: number;
}

export type RpcEvent = { readonly type: string; readonly [key: string]: unknown };

export class MalformedRpcOutputError extends Error {
  constructor(message = "Malformed RPC output") {
    super(message);
    this.name = "MalformedRpcOutputError";
  }
}

export class PrematureNonzeroExitError extends Error {
  constructor(message = "Pi RPC exited before settling") {
    super(message);
    this.name = "PrematureNonzeroExitError";
  }
}

export class RpcTimeoutError extends Error {
  constructor(message = "Pi RPC prompt timed out") {
    super(message);
    this.name = "RpcTimeoutError";
  }
}

type PromptState = {
  readonly id: string;
  resolve(result: AgentProcessResult): void;
  reject(error: Error): void;
  events: RpcEvent[];
  messages: unknown[];
  stderr: string;
  settled: boolean;
  accepted: boolean;
  timer?: NodeJS.Timeout;
  abortedByTimeout: boolean;
};

const parseEvent = (record: unknown): RpcEvent => {
  if (!record || typeof record !== "object" || !("type" in record) || typeof record.type !== "string") {
    throw new MalformedRpcOutputError();
  }

  return record as RpcEvent;
};

const isResponseFor = (event: RpcEvent, id: string): boolean =>
  event.type === "response" && event.id === id && event.command === "prompt";

const hasArrayMessages = (event: RpcEvent): event is RpcEvent & { readonly messages: ReadonlyArray<unknown> } =>
  Array.isArray(event.messages);

export class PiRpcAgentProcess implements AgentProcess {
  #options: Required<Pick<PiRpcAgentProcessOptions, "timeoutMs" | "abortGraceMs">> & PiRpcAgentProcessOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #stdoutDecoder = new JsonlDecoder();
  #stderrDecoder = new StringDecoder("utf8");
  #stderr = "";
  #requestCounter = 0;
  #currentPrompt: PromptState | undefined;
  #closing = false;
  #exitPromise: Promise<void> | undefined;
  #exitReject: ((error: Error) => void) | undefined;

  constructor(options: PiRpcAgentProcessOptions) {
    this.#options = {
      ...options,
      timeoutMs: options.timeoutMs ?? 30_000,
      abortGraceMs: options.abortGraceMs ?? 5_000,
    };
  }

  async start(): Promise<void> {
    if (this.#child) return;

    this.#child = spawn(
      "pi",
      ["--mode", "rpc", "--session-dir", this.#options.sessionDir, "--name", this.#options.name, "--model", this.#options.model],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    this.#child.stdout.on("data", (chunk: Buffer | string) => {
      try {
        this.#handleStdout(chunk);
      } catch (error) {
        const rpcError = error instanceof Error && error.message === "Invalid RPC JSON" ? new MalformedRpcOutputError() : error;
        void this.#failCurrentPrompt(rpcError instanceof Error ? rpcError : new MalformedRpcOutputError());
      }
    });

    this.#child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderr += this.#stderrDecoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      if (this.#currentPrompt) {
        this.#currentPrompt.stderr += this.#stderrDecoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
    });

    this.#child.once("exit", (code) => {
      void this.#handleExit(code ?? 0);
    });

    this.#exitPromise = new Promise<void>((_, reject) => {
      this.#exitReject = reject;
    });
  }

  async prompt(message: string): Promise<AgentProcessResult> {
    await this.start();

    if (!this.#child?.stdin) {
      throw new PrematureNonzeroExitError();
    }
    if (this.#currentPrompt) {
      throw new Error("Prompt already in flight");
    }

    const promptId = randomUUID();

    return await new Promise<AgentProcessResult>((resolve, reject) => {
      const state: PromptState = {
        id: promptId,
        resolve,
        reject,
        events: [],
        messages: [],
        stderr: "",
        settled: false,
        accepted: false,
        abortedByTimeout: false,
      };

      state.timer = setTimeout(() => {
        void this.#handleTimeout(state);
      }, this.#options.timeoutMs);

      this.#currentPrompt = state;
      this.#write({ id: promptId, type: "prompt", message });
    });
  }

  async abort(): Promise<void> {
    if (!this.#child?.stdin) return;

    this.#write({ type: "abort" });
  }

  async close(): Promise<void> {
    this.#closing = true;
    const child = this.#child;

    if (!child) return;

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    this.#child = undefined;
  }

  #write(payload: Record<string, unknown>): void {
    const child = this.#child;

    if (!child?.stdin?.writable) {
      throw new PrematureNonzeroExitError();
    }

    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #handleStdout(chunk: Buffer | string): void {
    const records = this.#stdoutDecoder.push(chunk);

    for (const record of records) {
      const event = parseEvent(record);
      const prompt = this.#currentPrompt;

      if (prompt) {
        prompt.events = [...prompt.events, event];

        if (event.type === "agent_end" && hasArrayMessages(event)) {
          prompt.messages = [...prompt.messages, ...event.messages];
        }

        if (isResponseFor(event, prompt.id)) {
          if (event.success === false) {
            void this.#failCurrentPrompt(new Error(String(event.error ?? "Prompt rejected")));
            return;
          }

          prompt.accepted = true;
        }

        if (event.type === "agent_settled") {
          prompt.settled = true;
          void this.#finishCurrentPrompt();
        }
      }
    }
  }

  async #handleTimeout(prompt: PromptState): Promise<void> {
    if (this.#currentPrompt !== prompt || prompt.settled) return;

    prompt.abortedByTimeout = true;
    await this.abort();

    setTimeout(() => {
      this.#child?.kill("SIGTERM");
    }, this.#options.abortGraceMs);

    await this.#failCurrentPrompt(new RpcTimeoutError());
  }

  async #handleExit(code: number): Promise<void> {
    if (this.#currentPrompt && !this.#currentPrompt.settled && !this.#closing) {
      await this.#failCurrentPrompt(new PrematureNonzeroExitError(`Pi RPC exited before settling (${code})`));
      return;
    }

    if (code !== 0 && this.#exitReject) {
      this.#exitReject(new PrematureNonzeroExitError(`Pi RPC exited with code ${code}`));
    }
  }

  async #finishCurrentPrompt(): Promise<void> {
    const prompt = this.#currentPrompt;
    if (!prompt || !prompt.accepted || !prompt.settled) return;

    if (prompt.timer) clearTimeout(prompt.timer);
    this.#currentPrompt = undefined;
    prompt.resolve({ messages: prompt.messages, events: prompt.events, stderr: prompt.stderr });
  }

  async #failCurrentPrompt(error: Error): Promise<void> {
    const prompt = this.#currentPrompt;
    if (!prompt) return;

    if (prompt.timer) clearTimeout(prompt.timer);
    this.#currentPrompt = undefined;
    prompt.reject(error);

    if (!this.#closing) {
      this.#child?.kill("SIGTERM");
    }
  }
}
