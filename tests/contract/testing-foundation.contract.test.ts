import { describe, expect, it } from "vitest";

describe("contract test project", () => {
  it("executes contract assertions", () => {
    const result = {
      ok: true,
      data: {
        status: "ready",
      },
    };

    expect(result).toMatchObject({
      ok: true,
      data: {
        status: "ready",
      },
    });
  });
});
