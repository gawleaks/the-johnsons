import { describe, expect, it, vi } from "vitest";
import { parseCommand } from "../../src/cli/arguments.js";

describe("parseCommand", () => {
  it("parses start with workspace and preset", () => {
    expect(parseCommand(["start", "--workspace", "/repo", "--preset", "fast"])).toEqual({
      type: "start",
      workspace: "/repo",
      preset: "fast",
    });
  });

  it("uses the current working directory when workspace is omitted", () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/workspace");

    expect(parseCommand(["resume", "run-1"])).toEqual({
      type: "resume",
      workspace: "/workspace",
      runId: "run-1",
    });

    cwd.mockRestore();
  });

  it("parses local configuration workspace", () => {
    expect(parseCommand(["config", "--workspace", "/repo"])).toEqual({ type: "config", workspace: "/repo" });
  });

  it("uses the current working directory when runs workspace is omitted", () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/workspace");

    expect(parseCommand(["runs"])).toEqual({
      type: "runs",
      workspace: "/workspace",
    });

    cwd.mockRestore();
  });

  it("accepts resume run id before workspace", () => {
    expect(parseCommand(["resume", "run-1", "--workspace", "/repo"])).toEqual({
      type: "resume",
      workspace: "/repo",
      runId: "run-1",
    });
  });

  it("rejects workspace before resume run id", () => {
    expect(() => parseCommand(["resume", "--workspace", "/repo", "run-1"])).toThrow(/order/i);
  });

  it("rejects unknown commands, missing values, duplicate flags, and incompatible flags", () => {
    expect(() => parseCommand(["destroy"])).toThrow("Unknown command");
    expect(() => parseCommand(["start", "--workspace"])).toThrow(/value/i);
    expect(() => parseCommand(["start", "--workspace", "/repo", "--workspace", "/other"])).toThrow(
      /duplicate/i,
    );
    expect(() => parseCommand(["resume", "run-1", "--preset", "fast"])).toThrow(/incompatible/i);
    expect(() => parseCommand(["runs", "--preset", "fast"])).toThrow(/incompatible/i);
    expect(() => parseCommand(["start", "--bogus", "value"])).toThrow(/unknown/i);
  });

  it.each([
    ["missing run id", ["resume"]],
    ["unsafe run id", ["resume", "."]],
    ["duplicated run arguments", ["resume", "run-1", "run-1"]],
    ["extra run arguments", ["resume", "run-1", "run-2"]],
  ])("rejects %s", (_label, argv) => {
    expect(() => parseCommand(argv as readonly string[])).toThrow(/run id|argument/i);
  });

  it.each(["", ".", "..", "/", "\\"])("rejects unsafe run id %j", (runId) => {
    expect(() => parseCommand(["resume", runId])).toThrow(/run id/i);
  });
});
