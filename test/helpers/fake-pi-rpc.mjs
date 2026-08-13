#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const [, , command, ...args] = process.argv;
const scenario = process.env.PI_FAKE_RPC_SCENARIO ?? "success";
const statePath = process.env.PI_FAKE_RPC_STATE;
const stdinLog = process.env.PI_FAKE_RPC_STDIN_LOG;
const signalLog = process.env.PI_FAKE_RPC_SIGNAL_LOG;
const decoder = new StringDecoder("utf8");
let buffer = "";

const step = (() => {
  if (!statePath) return 1;

  let current = 0;
  try {
    current = Number(readFileSync(statePath, "utf8")) || 0;
  } catch {
    current = 0;
  }

  const next = current + 1;
  writeFileSync(statePath, String(next));
  return next;
})();

const sequenceScenario =
  scenario === "restart-sequence"
    ? step === 1
      ? "restart-first"
      : "restart-second"
    : scenario === "timeout-sequence"
      ? step === 1
        ? "timeout-first"
        : "timeout-second"
      : scenario;

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

const writeSuccess = (promptId, delayMs = 0) => {
  setTimeout(() => {
    writeJson({ type: "agent_start" });
    writeJson({ id: promptId, type: "response", command: "prompt", success: true });
    writeJson({ type: "agent_end", messages: [{ role: "assistant", content: "done" }], willRetry: false });
    writeJson({ type: "agent_settled" });
  }, delayMs);
};

const handlePrompt = (promptId) => {
  if (sequenceScenario === "restart-first") {
    process.stdout.write('{"type":"agent_start"');
    process.stderr.write(Buffer.from([0xc3]), () => {
      process.removeAllListeners("SIGTERM");
      process.kill(process.pid, "SIGTERM");
    });
    return;
  }

  if (sequenceScenario === "restart-second") {
    process.stderr.write(Buffer.from([0xa9]));
    process.stderr.write("done");
    writeSuccess(promptId, 30);
    return;
  }

  if (sequenceScenario === "timeout-first") {
    setInterval(() => {}, 1_000);
    return;
  }

  if (sequenceScenario === "timeout-second") {
    process.stderr.write(Buffer.from([0xa9]));
    process.stderr.write("done");
    writeSuccess(promptId, 30);
    return;
  }

  if (sequenceScenario === "signal-exit") {
    process.removeAllListeners("SIGTERM");
    process.kill(process.pid, "SIGTERM");
    return;
  }

  if (scenario === "success") {
    writeSuccess(promptId);
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
        if (sequenceScenario === "timeout-first") {
          setTimeout(() => process.exit(0), 5);
        }
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
