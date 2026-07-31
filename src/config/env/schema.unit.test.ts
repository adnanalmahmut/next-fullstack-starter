import { describe, expect, it } from "vitest";

import { parseEnvironment } from "./parse";
import { publicEnvironmentSchema, serverEnvironmentSchema } from "./schema";

describe("serverEnvironmentSchema", () => {
  it("parses valid server configuration", () => {
    const result = serverEnvironmentSchema.parse({
      APP_ENV: "staging",
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "unit-test-only-better-auth-secret-value-000000",
    });

    expect(result).toEqual({
      APP_ENV: "staging",
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "unit-test-only-better-auth-secret-value-000000",
    });
  });

  it("rejects a missing authentication secret", () => {
    expect(() =>
      serverEnvironmentSchema.parse({
        APP_ENV: "production",
        NODE_ENV: "production",
      }),
    ).toThrow();
  });

  it("rejects an authentication secret shorter than 32 characters", () => {
    expect(() =>
      serverEnvironmentSchema.parse({
        APP_ENV: "production",
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "too-short",
      }),
    ).toThrow();
  });

  it("rejects missing server configuration", () => {
    expect(() => serverEnvironmentSchema.parse({})).toThrow();
  });

  it("rejects unsupported deployment environments", () => {
    expect(() =>
      serverEnvironmentSchema.parse({
        APP_ENV: "preview",
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "unit-test-only-better-auth-secret-value-000000",
      }),
    ).toThrow();
  });

  it("rejects undeclared server variables", () => {
    expect(() =>
      serverEnvironmentSchema.parse({
        APP_ENV: "development",
        NODE_ENV: "development",
        BETTER_AUTH_SECRET: "unit-test-only-better-auth-secret-value-000000",
        UNDECLARED_VARIABLE: "value",
      }),
    ).toThrow();
  });
});

describe("publicEnvironmentSchema", () => {
  it("parses a valid HTTPS application URL", () => {
    expect(
      publicEnvironmentSchema.parse({
        NEXT_PUBLIC_APP_URL: "https://example.com",
      }),
    ).toEqual({
      NEXT_PUBLIC_APP_URL: "https://example.com",
    });
  });

  it("parses a local HTTP application URL", () => {
    expect(
      publicEnvironmentSchema.parse({
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      }),
    ).toEqual({
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    });
  });

  it("rejects an invalid public application URL", () => {
    expect(() =>
      publicEnvironmentSchema.parse({
        NEXT_PUBLIC_APP_URL: "not-a-url",
      }),
    ).toThrow();
  });

  it("rejects non-HTTP application URLs", () => {
    expect(() =>
      publicEnvironmentSchema.parse({
        NEXT_PUBLIC_APP_URL: "mailto:admin@example.com",
      }),
    ).toThrow();
  });

  it("rejects variables outside the public allowlist", () => {
    expect(() =>
      publicEnvironmentSchema.parse({
        NEXT_PUBLIC_APP_URL: "https://example.com",
        DATABASE_URL: "postgresql://example",
      }),
    ).toThrow();
  });
});

describe("parseEnvironment", () => {
  it("returns parsed values", () => {
    const result = parseEnvironment("server", serverEnvironmentSchema, {
      APP_ENV: "production",
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "unit-test-only-better-auth-secret-value-000000",
    });

    expect(result.APP_ENV).toBe("production");
  });

  it("includes the scope and variable name in validation errors", () => {
    expect(() =>
      parseEnvironment("public", publicEnvironmentSchema, {
        NEXT_PUBLIC_APP_URL: "invalid",
      }),
    ).toThrowError(
      /Invalid public environment variables:[\s\S]*NEXT_PUBLIC_APP_URL/,
    );
  });
});
