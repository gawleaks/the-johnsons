import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  readonly scripts: Record<string, string>;
  readonly devDependencies: Record<string, string>;
};

describe("package metadata", () => {
  it("declares the Task 1 dev command and tsx dev dependency", () => {
    expect(packageJson.scripts.dev).toBe("tsx src/cli.ts");
    expect(packageJson.devDependencies.tsx).toBe("4.21.0");
  });
});
