import { describe, expect, it } from "vitest";
import { defaultPolicy, type Policy } from "../../src/policy/config.js";
import {
  TerminalRunUi,
  createTerminalIo,
  selectPolicy,
  type TerminalIo,
} from "../../src/ui/terminal.js";

const clonePolicy = (policy: Policy): Policy => JSON.parse(JSON.stringify(policy)) as Policy;

const createIo = (overrides: Partial<TerminalIo> = {}): TerminalIo & { readonly lines: string[] } => {
  const lines: string[] = [];

  return {
    lines,
    choose: async () => "default",
    confirm: async () => true,
    ask: async () => "",
    write: (line: string) => {
      lines.push(line);
    },
    ...overrides,
  };
};

describe("TerminalRunUi", () => {
  it("returns no approval until terminal confirmation is true", async () => {
    const rejected = new TerminalRunUi(createIo({ confirm: async () => false }));
    await expect(rejected.approveSpecification("spec")).resolves.toBe(false);

    const approved = new TerminalRunUi(createIo({ confirm: async () => true }));
    await expect(approved.approveSpecification("spec")).resolves.toBe(true);
  });

  it("asks the user question through the injected terminal io", async () => {
    const ui = new TerminalRunUi(createIo({ ask: async () => "answer" }));

    await expect(ui.askQuestion("planner", "Need detail?")).resolves.toBe("answer");
  });
});

describe("createTerminalIo", () => {
  it("retries choose only for invalid input", async () => {
    const answers = ["3", "b"];
    const lines: string[] = [];
    const io = createTerminalIo({
      question: async () => answers.shift() ?? "",
      write: (line) => {
        lines.push(line);
      },
    });

    await expect(io.choose("Pick one", ["a", "b"])).resolves.toBe("b");
    expect(lines.filter((line) => line === "Choose one of: a, b")).toHaveLength(1);
  });

  it.each([
    ["y", true],
    ["yes", true],
    ["Y", true],
    ["YES", true],
    ["n", false],
    ["true", false],
    ["", false],
  ])("treats %j as %j for confirm", async (answer, expected) => {
    const io = createTerminalIo({
      question: async () => answer,
      write: () => undefined,
    });

    await expect(io.confirm("Confirm", "Message")).resolves.toBe(expected);
  });
});

describe("selectPolicy", () => {
  it("returns the chosen preset and writes role assignments before confirmation", async () => {
    const io = createIo();

    await expect(selectPolicy(io, { default: defaultPolicy })).resolves.toEqual({
      name: "default",
      policy: defaultPolicy,
    });

    expect(io.lines).toContain("architect: openai/gpt-5.6-sol (thinking: max)");
    expect(io.lines).toContain("reviewer: anthropic/sonnet-5 (thinking: high)");
  });

  it("lets the user override a role model and thinking level before start", async () => {
    const prompts = ["moonshot/kimi-k2.8", "medium", "", "", "", "", "", ""];
    const base = clonePolicy(defaultPolicy);
    const io = createIo({
      ask: async () => prompts.shift() ?? "",
    });

    await expect(selectPolicy(io, { default: base })).resolves.toEqual({
      name: "default",
      policy: {
        ...base,
        roles: {
          ...base.roles,
          architect: {
            ...base.roles.architect,
            model: "moonshot/kimi-k2.8",
            thinking: "medium",
          },
        },
      },
    });
  });

  it("rejects an invalid thinking override", async () => {
    const prompts = ["", "ultra"];
    const io = createIo({
      ask: async () => prompts.shift() ?? "",
    });

    await expect(selectPolicy(io, { default: defaultPolicy })).rejects.toThrow(/invalid thinking level/i);
  });

  it("rejects when no preset is selected", async () => {
    const io = createIo({ choose: async () => undefined });

    await expect(selectPolicy(io, { default: defaultPolicy })).rejects.toThrow(/no preset selected/i);
  });

  it("re-prompts all role overrides after confirmation declines", async () => {
    const prompts = [
      "moonshot/kimi-k2.8", "medium", "", "", "", "", "", "",
      "", "", "", "", "", "", "", "",
    ];
    let confirmations = 0;
    const io = createIo({
      ask: async () => prompts.shift() ?? "",
      confirm: async () => {
        confirmations += 1;
        return confirmations > 1;
      },
    });

    await expect(selectPolicy(io, { default: defaultPolicy })).resolves.toEqual({
      name: "default",
      policy: {
        ...defaultPolicy,
        roles: {
          ...defaultPolicy.roles,
          architect: {
            ...defaultPolicy.roles.architect,
            model: "moonshot/kimi-k2.8",
            thinking: "medium",
          },
        },
      },
    });

    expect(confirmations).toBe(2);
  });
});
