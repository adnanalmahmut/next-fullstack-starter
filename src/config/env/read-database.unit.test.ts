import { describe, expect, it } from "vitest";

import { readDatabaseEnvironment } from "./read-database";

const DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/next_fullstack_starter";

describe("readDatabaseEnvironment", () => {
  it("returns validated database configuration", () => {
    expect(
      readDatabaseEnvironment({
        DATABASE_URL,
      }),
    ).toEqual({
      DATABASE_URL,
    });
  });

  it("reports a missing database URL", () => {
    expect(() => readDatabaseEnvironment({})).toThrow(
      /Invalid database environment variables:[\s\S]*DATABASE_URL/,
    );
  });

  it("reports an invalid database URL", () => {
    expect(() =>
      readDatabaseEnvironment({
        DATABASE_URL: "mysql://localhost/database",
      }),
    ).toThrow(/Invalid database environment variables/);
  });
});
