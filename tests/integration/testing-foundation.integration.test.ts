import { describe, expect, it } from "vitest";

describe("integration test project", () => {
  it("executes in the Node.js environment", () => {
    expect(process.release.name).toBe("node");
  });
});
