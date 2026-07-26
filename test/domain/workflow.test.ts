import { describe, expect, it } from "vitest";
import { createRunState } from "../../src/domain/types.js";

describe("createRunState", () => {
  it("starts awaiting an architect specification", () => {
    expect(createRunState("run-1", "/repo").phase).toBe("architecting");
  });
});
