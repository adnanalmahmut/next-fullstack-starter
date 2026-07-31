import { describe, expect, it } from "vitest";

import { readServerEnvironment } from "./read-server";

describe("readServerEnvironment", () => {
  it("returns validated server configuration", () => {
    expect(
      readServerEnvironment({
        APP_ENV: "staging",
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "unit-test-only-better-auth-secret-value-000000",
      }),
    ).toEqual({
      APP_ENV: "staging",
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "unit-test-only-better-auth-secret-value-000000",
    });
  });

  it("rejects a missing application environment", () => {
    expect(() =>
      readServerEnvironment({
        APP_ENV: undefined,
        NODE_ENV: "test",
        BETTER_AUTH_SECRET: "unit-test-only-better-auth-secret-value-000000",
      }),
    ).toThrowError(/APP_ENV/);
  });

  it("rejects an invalid Node environment", () => {
    expect(() =>
      readServerEnvironment({
        APP_ENV: "test",
        NODE_ENV: "staging",
        BETTER_AUTH_SECRET: "unit-test-only-better-auth-secret-value-000000",
      }),
    ).toThrowError(/NODE_ENV/);
  });

  it("rejects a missing authentication secret", () => {
    expect(() =>
      readServerEnvironment({
        APP_ENV: "test",
        NODE_ENV: "test",
        BETTER_AUTH_SECRET: undefined,
      }),
    ).toThrowError(/BETTER_AUTH_SECRET/);
  });
});
