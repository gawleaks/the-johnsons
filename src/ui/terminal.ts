import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Role } from "../domain/types.js";
import type { RunUi } from "../orchestrator/run-controller.js";
import { validatePolicy, type Policy, type RoleConfig, type ThinkingLevel } from "../policy/config.js";

export interface TerminalIo {
  choose(title: string, options: readonly string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  ask(title: string): Promise<string>;
  write(line: string): void;
}

const roles = ["architect", "planner", "developer", "reviewer"] as const;
const thinkingLevels = new Set<ThinkingLevel>(["off", "low", "medium", "high", "max"]);

const question = async (prompt: string): Promise<string> => {
  const readline = createInterface({ input: stdin, output: stdout });

  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
};

export const createTerminalIo = (): TerminalIo => ({
  choose: async (title, options) => {
    const values = new Set(options);

    while (true) {
      stdout.write(`${title}\n`);
      options.forEach((option, index) => stdout.write(`${index + 1}. ${option}\n`));
      const answer = (await question("> ")).trim();
      const byIndex = Number.parseInt(answer, 10);
      const choice = Number.isInteger(byIndex) ? options[byIndex - 1] : answer;

      if (choice === undefined || !values.has(choice)) {
        stdout.write(`Choose one of: ${options.join(", ")}\n`);
        continue;
      }

      return choice;
    }
  },
  confirm: async (title, message) => {
    stdout.write(`${title}\n${message}\n`);
    return ["y", "yes"].includes((await question("Confirm [y/N]: ")).trim().toLowerCase());
  },
  ask: async (title) => (await question(`${title}: `)).trim(),
  write: (line) => {
    stdout.write(`${line}\n`);
  },
});

const clonePolicy = (policy: Policy): Policy => JSON.parse(JSON.stringify(policy)) as Policy;

const updateRole = async (io: TerminalIo, role: Role, config: RoleConfig): Promise<RoleConfig> => {
  const model = await io.ask(`Model for ${role} (blank keeps ${config.model})`);
  const nextThinking = await io.ask(`Thinking for ${role} (blank keeps ${config.thinking})`);

  if (nextThinking !== "" && !thinkingLevels.has(nextThinking as ThinkingLevel)) {
    throw new Error(`Invalid thinking level for ${role}: ${nextThinking}`);
  }

  return {
    ...config,
    ...(model === "" ? {} : { model }),
    ...(nextThinking === "" ? {} : { thinking: nextThinking as ThinkingLevel }),
  };
};

const assignmentLines = (policy: Policy): ReadonlyArray<string> =>
  roles.map((role) => `${role}: ${policy.roles[role].model} (thinking: ${policy.roles[role].thinking})`);

export const selectPolicy = async (
  io: TerminalIo,
  presets: Readonly<Record<string, Policy>>,
): Promise<{ readonly name: string; readonly policy: Policy }> => {
  const names = Object.keys(presets).sort();
  const name = await io.choose("Choose a policy preset", names);

  if (!name) {
    throw new Error("No preset selected");
  }

  let policy = clonePolicy(presets[name] ?? (() => { throw new Error(`Unknown preset: ${name}`); })());

  while (true) {
    const updatedRoles = await roles.reduce<Promise<Array<readonly [Role, RoleConfig]>>>(
      async (pending, role) => [
        ...(await pending),
        [role, await updateRole(io, role, policy.roles[role])] as const,
      ],
      Promise.resolve([]),
    );
    policy = validatePolicy({
      ...policy,
      roles: Object.fromEntries(updatedRoles) as Policy["roles"],
    });

    assignmentLines(policy).forEach((line) => io.write(line));

    if (await io.confirm("Start run", assignmentLines(policy).join("\n"))) {
      return { name, policy };
    }
  }
};

export class TerminalRunUi implements RunUi {
  constructor(private readonly io: TerminalIo) {}

  async approveSpecification(specification: string): Promise<boolean> {
    this.io.write("Specification:");
    this.io.write(specification);
    return this.io.confirm("Approve specification", specification);
  }

  async askQuestion(role: Role, question: string): Promise<string> {
    this.io.write(`${role} asks: ${question}`);
    return this.io.ask(`Answer for ${role}`);
  }

  async resolveEscalation(): Promise<boolean> {
    return this.io.confirm("Reviewer escalation", "Resume after escalation?");
  }
}
