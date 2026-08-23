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

    expect(parseCommand(["runs"])).toEqual({
      type: "runs",
      workspace: "/workspace",
    });

    cwd.mockRestore();
  });

  it("rejects unknown commands, missing values, duplicate flags, and incompatible flags", () => {
    expect(() => parseCommand(["destroy"])).toThrow("Unknown command");
    expect(() => parseCommand(["resume"])).toThrow(/run id/i);
    expect(() => parseCommand(["start", "--workspace"])).toThrow(/value/i);
    expect(() => parseCommand(["start", "--workspace", "/repo", "--workspace", "/other"])).toThrow(
      /duplicate/i,
    );
    expect(() => parseCommand(["resume", "run-1", "--preset", "fast"])).toThrow(/incompatible/i);
    expect(() => parseCommand(["runs", "--preset", "fast"])).toThrow(/incompatible/i);
    expect(() => parseCommand(["start", "--bogus", "value"])).toThrow(/unknown/i);
  });

  it.each(["", ".", "..", "/", "\\"])("rejects unsafe run id %j", (runId) => {
    expect(() => parseCommand(["resume", runId])).toThrow(/run id/i);
  });
});
