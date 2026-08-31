import { describe, expect, it } from "vitest";
import { defaultPolicy, type Policy } from "../../src/policy/config.js";
import {
  TerminalRunUi,
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
});
