import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const helperPath = fileURLToPath(new URL("../helpers/fake-pi-rpc.mjs", import.meta.url));

const spawnCalls: Array<{ command: string; args: ReadonlyArray<string>; cwd?: string }> = [];
const spawnedChildren: ChildProcessWithoutNullStreams[] = [];

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (command: string, args: ReadonlyArray<string>, options: any) => {
      spawnCalls.push({ command, args, cwd: options?.cwd });

      const child = actual.spawn(process.execPath, [helperPath, command, ...args], {
        ...options,
        env: {
          ...process.env,
          ...options?.env,
        },
      });

      spawnedChildren.push(child as ChildProcessWithoutNullStreams);
      return child;
    },
  };
});

import {
  AgentProcessClosedError,
  MalformedRpcOutputError,
  PiRpcAgentProcess,
  PrematureExitError,
  PrematureNonzeroExitError,
  RpcTimeoutError,
} from "../../src/rpc/agent-process.js";

const tempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "johnsons-agent-process-"));

const withTempDir = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await tempDir();

  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const createProcess = (root: string, cwd?: string) =>
  new PiRpcAgentProcess({
    sessionDir: join(root, "session"),
    name: "demo-run",
    model: "demo/model",
    thinking: "low",
    tools: ["read"],
    cwd,
    timeoutMs: 80,
    abortGraceMs: 20,
  });

const signalLog = (root: string): string => join(root, "signal.log");
const stateLog = (root: string): string => join(root, "state.log");
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const readSignalLog = async (root: string): Promise<string> => {
  try {
    return await readFile(signalLog(root), "utf8");
  } catch {
    return "";
  }
};

const isAlive = (pid: number | undefined): boolean => {
  if (!pid) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("PiRpcAgentProcess", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnedChildren.length = 0;
    delete process.env.PI_FAKE_RPC_SCENARIO;
    delete process.env.PI_FAKE_RPC_STDIN_LOG;
    delete process.env.PI_FAKE_RPC_SIGNAL_LOG;
    delete process.env.PI_FAKE_RPC_STATE;
  });

  it("resolves prompt after prompt acceptance and agent_settled", async () => {
    await withTempDir(async (root) => {
      process.env.PI_FAKE_RPC_SCENARIO = "success";
      process.env.PI_FAKE_RPC_STDIN_LOG = join(root, "stdin.log");

      const agent = createProcess(root);
      await agent.start();
      const result = await agent.prompt("hello");

      expect(result.events.map((event) => event.type)).toEqual([
        "agent_start",
        "response",
        "agent_end",
        "agent_settled",
      ]);
      expect(result.messages).toEqual([{ role: "assistant", content: "done" }]);
      expect(result.stderr).toBe("");
    });
  });

  it("throws for malformed JSON output", async () => {
    await withTempDir(async (root) => {
      process.env.PI_FAKE_RPC_SCENARIO = "malformed";

      const agent = createProcess(root);
      await agent.start();

      await expect(agent.prompt("hello")).rejects.toBeInstanceOf(MalformedRpcOutputError);
    });
  });

  it("restarts with fresh decoder state after a child exits", async () => {
    await withTempDir(async (root) => {
      process.env.PI_FAKE_RPC_SCENARIO = "restart-sequence";
      process.env.PI_FAKE_RPC_STATE = stateLog(root);

      const agent = createProcess(root);
      await expect(agent.prompt("first")).rejects.toBeInstanceOf(PrematureNonzeroExitError);

      const result = await agent.prompt("second");

      expect(result.events.map((event) => event.type)).toEqual([
        "agent_start",
        "response",
        "agent_end",
        "agent_settled",
      ]);
      expect(result.messages).toEqual([{ role: "assistant", content: "done" }]);
      expect(result.stderr).toBe("�done");
    });
  });

  it("does not SIGTERM a restarted child after timeout grace", async () => {
    await withTempDir(async (root) => {
      process.env.PI_FAKE_RPC_SCENARIO = "timeout-sequence";
      process.env.PI_FAKE_RPC_STATE = stateLog(root);
      process.env.PI_FAKE_RPC_SIGNAL_LOG = signalLog(root);

      const agent = createProcess(root);
      await expect(agent.prompt("first")).rejects.toBeInstanceOf(RpcTimeoutError);

      const pid = spawnedChildren[0]?.pid;
      for (let waited = 0; pid && isAlive(pid) && waited < 20; waited += 2) {
        await wait(2);
      }

      expect(isAlive(pid)).toBe(false);

      const result = await agent.prompt("second");

      expect(result.messages).toEqual([{ role: "assistant", content: "done" }]);
      expect(await readSignalLog(root)).toBe("");
    });
  });

  it("aborts on timeout before terminating the child", async () => {
    await withTempDir(async (root) => {
      process.env.PI_FAKE_RPC_SCENARIO = "timeout";
      process.env.PI_FAKE_RPC_STDIN_LOG = join(root, "stdin.log");
      process.env.PI_FAKE_RPC_SIGNAL_LOG = signalLog(root);

      const agent = new PiRpcAgentProcess({
        sessionDir: join(root, "session"),
        name: "demo-run",
        model: "demo/model",
        thinking: "low",
        tools: ["read"],
        timeoutMs: 80,
        abortGraceMs: 500,
      });
      await agent.start();

      const stdin = spawnedChildren[0]?.stdin;
      if (!stdin) throw new Error("Missing stdin");
      const originalWrite = stdin.write.bind(stdin);
      let abortCallbackCompleted = false;
      const writeSpy = vi.spyOn(stdin, "write").mockImplementation(
        ((chunk: any, ...rest: Array<any>) => {
          const payload = typeof chunk === "string" ? chunk : chunk.toString("utf8");
          const callback = rest.at(-1);

          if (payload.includes('"type":"abort"') && typeof callback === "function") {
            expect(JSON.parse(payload)).toMatchObject({
              type: "abort",
              id: expect.any(String),
            });
            const args = rest.slice(0, -1);

            return originalWrite(
              chunk,
              ...args,
              ((error?: Error | null) => {
                setTimeout(() => {
                  abortCallbackCompleted = true;
                  callback(error);
                }, 20);
              }) as any,
            );
          }

          return originalWrite(chunk, ...rest);
        }) as any,
      );

      try {
        const pid = spawnedChildren[0]?.pid;
        const prompt = agent.prompt("hello");

        await expect(
          prompt.catch(async (error) => {
            expect(abortCallbackCompleted).toBe(true);
            expect(await readSignalLog(root)).toBe("");
            expect(isAlive(pid)).toBe(true);
            throw error;
          }),
        ).rejects.toBeInstanceOf(RpcTimeoutError);

        await new Promise((resolve) => setTimeout(resolve, 550));

        expect(await readSignalLog(root)).toContain("SIGTERM");
        expect(isAlive(pid)).toBe(false);
      } finally {
        writeSpy.mockRestore();
      }

    });
  });

  it("settles a pending prompt when closed", async () => {
    await withTempDir(async (root) => {
      process.env.PI_FAKE_RPC_SCENARIO = "timeout";
      process.env.PI_FAKE_RPC_SIGNAL_LOG = signalLog(root);

      const agent = createProcess(root);
      await agent.start();
      const prompt = agent.prompt("hello");
      const closing = agent.close();
      const promptAssertion = expect(prompt).rejects.toBeInstanceOf(AgentProcessClosedError);

      await promptAssertion;
      await expect(closing).resolves.toBeUndefined();
    });
  });

  it("throws PrematureExitError for a clean exit before settlement", async () => {
    await withTempDir(async (root) => {
      process.env.PI_FAKE_RPC_SCENARIO = "clean";

      const agent = createProcess(root);
      await agent.start();

      await expect(agent.prompt("hello")).rejects.toBeInstanceOf(PrematureExitError);
    });
  });

  it("does not wait for a second exit event when closing an exited child", async () => {
    await withTempDir(async (root) => {
      process.env.PI_FAKE_RPC_SCENARIO = "clean";

      const agent = createProcess(root);
      await agent.start();
      await expect(agent.prompt("hello")).rejects.toBeInstanceOf(PrematureExitError);

      await expect(
        Promise.race([
          agent.close(),
          new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 50)),
        ]),
      ).resolves.not.toBe("timed-out");
    });
  });

  it("throws for a signal exit before settlement", async () => {
    await withTempDir(async (root) => {
      process.env.PI_FAKE_RPC_SCENARIO = "signal-exit";

      const agent = createProcess(root);
      await agent.start();

      await expect(agent.prompt("hello")).rejects.toBeInstanceOf(PrematureNonzeroExitError);
    });
  });

  it("throws for a premature nonzero exit", async () => {
    await withTempDir(async (root) => {
      process.env.PI_FAKE_RPC_SCENARIO = "nonzero";

      const agent = createProcess(root);
      await agent.start();

      await expect(agent.prompt("hello")).rejects.toBeInstanceOf(PrematureNonzeroExitError);
    });
  });

  it("spawns pi with rpc arguments", async () => {
    await withTempDir(async (root) => {
      process.env.PI_FAKE_RPC_SCENARIO = "success";

      const agent = createProcess(root);
      await agent.start();

      expect(spawnCalls[0]).toEqual({
        command: "pi",
        args: [
          "--mode",
          "rpc",
          "--session-dir",
          join(root, "session"),
          "--name",
          "demo-run",
          "--model",
          "demo/model",
          "--thinking",
          "low",
          "--tools",
          "read",
        ],
        cwd: undefined,
      });

      await agent.close();
    });
  });

  it("passes cwd to the pi child when supplied", async () => {
    await withTempDir(async (root) => {
      process.env.PI_FAKE_RPC_SCENARIO = "success";
      const cwd = join(root, "worktree");
      await mkdir(cwd, { recursive: true });

      const agent = createProcess(root, cwd);
      await agent.start();

      expect(spawnCalls[0]?.cwd).toBe(cwd);

      await agent.close();
    });
  });
});
