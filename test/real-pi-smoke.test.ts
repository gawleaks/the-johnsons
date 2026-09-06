import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcAgentProcess } from "../src/rpc/agent-process.js";

const enabled = process.env.JOHNSONS_REAL_PI_SMOKE === "1";
const model = process.env.JOHNSONS_REAL_PI_MODEL;

const smoke = enabled && model !== undefined ? it : it.skip;

describe("real Pi RPC smoke", () => {
  smoke("runs a configured authenticated Pi model", async () => {
    const root = await mkdtemp(join(tmpdir(), "johnsons-real-pi-"));
    const agent = new PiRpcAgentProcess({
      sessionDir: join(root, "session"),
      name: "johnsons-real-pi-smoke",
      model: model!,
      thinking: "off",
      tools: ["read"],
      timeoutMs: 60_000,
      abortGraceMs: 1_000,
    });

    try {
      await agent.start();
      const result = await agent.prompt("Reply with exactly: smoke-ok");
      const assistant = [...result.messages].reverse().find((message): message is { content: unknown } =>
        typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant",
      );
      const content = assistant?.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string").map((part) => part.text).join("")
          : "";
      expect(text).toBe("smoke-ok");
    } finally {
      await agent.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
