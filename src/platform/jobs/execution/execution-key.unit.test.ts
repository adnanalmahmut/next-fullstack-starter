import { describe, expect, it } from "vitest";

import { jobExecutionKey } from "./execution-key";

describe("the execution key", () => {
  it("is stable for the same work", () => {
    // Every process has to derive the same key for the same work, or the
    // receipt table stops meaning anything.
    expect(jobExecutionKey("identity.user-deleted", 1, "u-1")).toBe(
      jobExecutionKey("identity.user-deleted", 1, "u-1"),
    );
  });

  it("differs by job, by version, and by domain key", () => {
    const keys = new Set([
      jobExecutionKey("identity.user-deleted", 1, "u-1"),
      jobExecutionKey("identity.user-restored", 1, "u-1"),
      // A v2 that fixes a calculation must be free to run over a row v1 touched.
      jobExecutionKey("identity.user-deleted", 2, "u-1"),
      jobExecutionKey("identity.user-deleted", 1, "u-2"),
    ]);

    expect(keys.size).toBe(4);
  });

  it("cannot be confused by a domain key that looks like a version", () => {
    expect(jobExecutionKey("a.b", 1, "1 c")).not.toBe(
      jobExecutionKey("a.b", 11, "c"),
    );
  });

  it("discloses nothing about the value it was derived from", () => {
    const key = jobExecutionKey("billing.receipt", 1, "person@example.com");

    expect(key).not.toContain("person");
    expect(key).not.toContain("example.com");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fits the column it is stored in", () => {
    expect(jobExecutionKey("a.b", 1, "x".repeat(10_000))).toHaveLength(64);
  });

  it("refuses an empty domain key", () => {
    // An empty key would make every delivery of the job the same operation.
    expect(() => jobExecutionKey("a.b", 1, "")).toThrow(/domain key/);
    expect(() =>
      jobExecutionKey("a.b", 1, undefined as unknown as string),
    ).toThrow(/domain key/);
  });
});
