import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { JsonlDecoder } from "./jsonl.js";
import { Buffer } from "node:buffer";

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

export type RpcEvent = {
  readonly type: string;
  readonly [key: string]: unknown;
};

export class MalformedRpcOutputError extends Error {
  constructor(message = "Malformed RPC output") {
    super(message);
    this.name = "MalformedRpcOutputError";
  }
}

export class PrematureExitError extends Error {
  constructor(message = "Pi RPC exited before settling") {
    super(message);
    this.name = "PrematureExitError";
  }
}

export class PrematureNonzeroExitError extends PrematureExitError {
  constructor(message = "Pi RPC exited before settling") {
    super(message);
    this.name = "PrematureNonzeroExitError";
  }
}

export class AgentProcessClosedError extends Error {
  constructor(message = "Pi RPC process was closed") {
    super(message);
    this.name = "AgentProcessClosedError";
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
  if (
    !record ||
    typeof record !== "object" ||
    !("type" in record) ||
    typeof record.type !== "string"
  ) {
    throw new MalformedRpcOutputError();
  }

  return record as RpcEvent;
};

const isResponseFor = (event: RpcEvent, id: string): boolean =>
  event.type === "response" && event.id === id && event.command === "prompt";

const hasArrayMessages = (
  event: RpcEvent,
): event is RpcEvent & { readonly messages: ReadonlyArray<unknown> } =>
  Array.isArray(event.messages);

export class PiRpcAgentProcess implements AgentProcess {
  #options: Required<
    Pick<PiRpcAgentProcessOptions, "timeoutMs" | "abortGraceMs">
  > &
    PiRpcAgentProcessOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #exitPromise: Promise<void> | undefined;
  #stdoutDecoder = new JsonlDecoder();
  #stderrDecoder = new StringDecoder("utf8");
  #stderr = "";
  #requestCounter = 0;
  #currentPrompt: PromptState | undefined;
  #timeoutGraceTimer: NodeJS.Timeout | undefined;
  #timeoutGraceChild: ChildProcessWithoutNullStreams | undefined;
  #closing = false;

  constructor(options: PiRpcAgentProcessOptions) {
    this.#options = {
      ...options,
      timeoutMs: options.timeoutMs ?? 30_000,
      abortGraceMs: options.abortGraceMs ?? 5_000,
    };
  }

  async start(): Promise<void> {
    if (this.#child) return;

    const child = spawn(
      "pi",
      [
        "--mode",
        "rpc",
        "--session-dir",
        this.#options.sessionDir,
        "--name",
        this.#options.name,
        "--model",
        this.#options.model,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    this.#child = child;
    this.#stdoutDecoder = new JsonlDecoder();
    this.#stderrDecoder = new StringDecoder("utf8");

    child.stdout.on("data", (chunk: Buffer | string) => {
      try {
        this.#handleStdout(chunk);
      } catch (error) {
        const rpcError =
          error instanceof Error && error.message === "Invalid RPC JSON"
            ? new MalformedRpcOutputError()
            : error;
        void this.#failCurrentPrompt(
          rpcError instanceof Error ? rpcError : new MalformedRpcOutputError(),
        );
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = this.#stderrDecoder.write(
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      );

      this.#stderr += text;

      if (this.#currentPrompt) {
        this.#currentPrompt.stderr += text;
      }
    });

    this.#exitPromise = new Promise<void>((resolve) => {
      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.#timeoutGraceChild === child) this.#clearTimeoutGraceTimer();
        if (this.#child === child) this.#child = undefined;
        void this.#handleExit(code, signal);
        resolve();
      });
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

    const promptPromise = new Promise<AgentProcessResult>((resolve, reject) => {
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
    });

    try {
      await this.#write({ id: promptId, type: "prompt", message });
    } catch (error) {
      await this.#failCurrentPrompt(
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    return await promptPromise;
  }

  async abort(): Promise<void> {
    if (!this.#child?.stdin) return;

    await this.#write({ id: randomUUID(), type: "abort" });
  }

  async close(): Promise<void> {
    this.#closing = true;
    const child = this.#child;
    const exited = this.#exitPromise;

    if (!child) return;
    if (!exited) throw new Error("Missing child exit promise");

    this.#clearTimeoutGraceTimer();
    await this.#failCurrentPrompt(new AgentProcessClosedError(), false);
    child.kill("SIGTERM");
    await exited;
  }

  #write(payload: Record<string, unknown>): Promise<void> {
    const child = this.#child;

    if (!child?.stdin?.writable) {
      throw new PrematureNonzeroExitError();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        child.stdin.off("error", onError);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      const onError = (error: Error): void => {
        finish(error);
      };

      child.stdin.once("error", onError);

      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`, (error?: Error | null) => {
          finish(error ?? undefined);
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
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
            void this.#failCurrentPrompt(
              new Error(String(event.error ?? "Prompt rejected")),
            );
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

    const child = this.#child;
    if (!child) return;

    prompt.abortedByTimeout = true;
    this.#timeoutGraceChild = child;
    this.#timeoutGraceTimer = setTimeout(() => {
      if (this.#timeoutGraceChild === child) child.kill("SIGTERM");
    }, this.#options.abortGraceMs);

    await this.abort().catch(() => undefined);
    await this.#failCurrentPrompt(new RpcTimeoutError(), false);
  }

  async #handleExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.#currentPrompt && !this.#currentPrompt.settled) {
      const error = this.#closing
        ? new AgentProcessClosedError()
        : signal || code !== 0
          ? new PrematureNonzeroExitError(
              `Pi RPC exited before settling (${signal ? `signal ${signal}` : `code ${code ?? 0}`})`,
            )
          : new PrematureExitError(
              `Pi RPC exited before settling (${code ?? 0})`,
            );
      await this.#failCurrentPrompt(error, false);
    }
  }

  async #finishCurrentPrompt(): Promise<void> {
    const prompt = this.#currentPrompt;
    if (!prompt || !prompt.accepted || !prompt.settled) return;

    if (prompt.timer) clearTimeout(prompt.timer);
    this.#clearTimeoutGraceTimer();
    this.#currentPrompt = undefined;
    prompt.resolve({
      messages: prompt.messages,
      events: prompt.events,
      stderr: prompt.stderr,
    });
  }

  async #failCurrentPrompt(error: Error, terminateChild = true): Promise<void> {
    const prompt = this.#currentPrompt;
    if (!prompt) return;

    if (prompt.timer) clearTimeout(prompt.timer);
    this.#currentPrompt = undefined;
    prompt.reject(error);

    if (terminateChild && !this.#closing) {
      this.#child?.kill("SIGTERM");
    }
  }

  #clearTimeoutGraceTimer(): void {
    if (this.#timeoutGraceTimer) clearTimeout(this.#timeoutGraceTimer);
    this.#timeoutGraceTimer = undefined;
    this.#timeoutGraceChild = undefined;
  }
}
