#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const [, , command, ...args] = process.argv;
const scenario = process.env.PI_FAKE_RPC_SCENARIO ?? "success";
const stdinLog = process.env.PI_FAKE_RPC_STDIN_LOG;
const signalLog = process.env.PI_FAKE_RPC_SIGNAL_LOG;
const decoder = new StringDecoder("utf8");
let buffer = "";

const logStdin = (line) => {
  if (!stdinLog) return;
  appendFileSync(stdinLog, `${line}\n`);
};

if (stdinLog) {
  appendFileSync(stdinLog, "");
}

if (signalLog) {
  appendFileSync(signalLog, "");
}

const writeJson = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const logSignal = (line) => {
  if (!signalLog) return;

  appendFileSync(signalLog, `${line}\n`);
};

const handlePrompt = (promptId) => {
  if (scenario === "success") {
    writeJson({ type: "agent_start" });
    writeJson({ id: promptId, type: "response", command: "prompt", success: true });
    writeJson({ type: "agent_end", messages: [{ role: "assistant", content: "done" }], willRetry: false });
    writeJson({ type: "agent_settled" });
    return;
  }

  if (scenario === "malformed") {
    process.stdout.write("{not json}\n");
    process.exit(0);
    return;
  }

  if (scenario === "nonzero") {
    process.stderr.write("boom\n");
    process.exit(17);
    return;
  }

  if (scenario === "clean") {
    process.exit(0);
    return;
  }

  if (scenario === "timeout") {
    setInterval(() => {}, 1_000);
  }
};

process.on("SIGTERM", () => {
  logSignal("SIGTERM");
  process.exit(0);
});

process.stdin.on("data", (chunk) => {
  buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

  const parts = buffer.split("\n");
  buffer = parts.pop() ?? "";

  for (const part of parts) {
    const line = part.endsWith("\r") ? part.slice(0, -1) : part;
    logStdin(line);

    try {
      const message = JSON.parse(line);
      if (message.type === "prompt") {
        handlePrompt(message.id);
      }
      if (message.type === "abort") {
        process.stderr.write("aborted\n");
      }
    } catch {
      process.stdout.write("{bad json}\n");
    }
  }
});

process.stdin.on("end", () => {
  buffer += decoder.end();
});

process.stdin.resume();

logStdin(JSON.stringify({ command, args }));
