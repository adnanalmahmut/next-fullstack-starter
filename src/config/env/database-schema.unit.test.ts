import { describe, expect, it } from "vitest";

import { databaseEnvironmentSchema } from "./schema";

describe("databaseEnvironmentSchema", () => {
  it.each([
    "postgresql://postgres:postgres@localhost:5432/app",
    "postgres://postgres:postgres@localhost:5432/app",
  ])("accepts PostgreSQL URL %s", (DATABASE_URL) => {
    expect(
      databaseEnvironmentSchema.parse({
        DATABASE_URL,
      }),
    ).toEqual({
      DATABASE_URL,
    });
  });

  it("rejects non-PostgreSQL URLs", () => {
    expect(
      databaseEnvironmentSchema.safeParse({
        DATABASE_URL: "https://example.com/database",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown variables", () => {
    expect(
      databaseEnvironmentSchema.safeParse({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/app",
        UNKNOWN_VARIABLE: "value",
      }).success,
    ).toBe(false);
  });
});
