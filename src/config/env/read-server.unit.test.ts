import { describe, expect, it } from "vitest";

import { readServerEnvironment } from "./read-server";

describe("readServerEnvironment", () => {
  it("returns validated server configuration", () => {
    expect(
      readServerEnvironment({
        APP_ENV: "staging",
        NODE_ENV: "production",
      }),
    ).toEqual({
      APP_ENV: "staging",
      NODE_ENV: "production",
    });
  });

  it("rejects a missing application environment", () => {
    expect(() =>
      readServerEnvironment({
        APP_ENV: undefined,
        NODE_ENV: "test",
      }),
    ).toThrowError(/APP_ENV/);
  });

  it("rejects an invalid Node environment", () => {
    expect(() =>
      readServerEnvironment({
        APP_ENV: "test",
        NODE_ENV: "staging",
      }),
    ).toThrowError(/NODE_ENV/);
  });
});
