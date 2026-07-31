import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const helperPath = fileURLToPath(new URL("../helpers/fake-pi-rpc.mjs", import.meta.url));

const actualSpawn = vi.hoisted(() => ({
  spawn: undefined as unknown as typeof import("node:child_process").spawn,
}));

const spawnCalls: Array<{ command: string; args: ReadonlyArray<string> }> = [];

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  actualSpawn.spawn = actual.spawn;

  return {
    ...actual,
    spawn: (command: string, args: ReadonlyArray<string>, options: any) => {
      spawnCalls.push({ command, args });

      return actual.spawn(process.execPath, [helperPath, command, ...args], {
        ...options,
        env: {
          ...process.env,
          ...options?.env,
        },
      });
    },
  };
});

import { PiRpcAgentProcess, MalformedRpcOutputError, PrematureNonzeroExitError, RpcTimeoutError } from "../../src/rpc/agent-process.js";

const tempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "johnsons-agent-process-"));

const withTempDir = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await tempDir();

  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const createProcess = (root: string) =>
  new PiRpcAgentProcess({
    sessionDir: join(root, "session"),
    name: "demo-run",
    model: "demo/model",
    timeoutMs: 50,
    abortGraceMs: 20,
  });

describe("PiRpcAgentProcess", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    delete process.env.PI_FAKE_RPC_SCENARIO;
    delete process.env.PI_FAKE_RPC_STDIN_LOG;
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

  it("aborts on timeout before terminating the child", async () => {
    await withTempDir(async (root) => {
      const stdinLog = join(root, "stdin.log");
      process.env.PI_FAKE_RPC_SCENARIO = "timeout";
      process.env.PI_FAKE_RPC_STDIN_LOG = stdinLog;

      const agent = createProcess(root);
      await agent.start();

      await expect(agent.prompt("hello")).rejects.toBeInstanceOf(RpcTimeoutError);

      const stdin = await readFile(stdinLog, "utf8");
      expect(stdin).toContain('"type":"prompt"');
      expect(stdin).toContain('"type":"abort"');
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
        ],
      });

      await agent.close();
    });
  });
});
