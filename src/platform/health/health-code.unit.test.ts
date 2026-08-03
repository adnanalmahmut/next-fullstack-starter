import { describe, expect, it } from "vitest";

/**
 * The published code set.
 *
 * These codes are the part of this platform something outside the repository
 * depends on — a load balancer rule, a deployment gate, an alert — so the tests
 * here are about the set itself: that it is closed and that it is spelled the way
 * it is documented.
 *
 * Three of them are also declared by the areas that own those checks, so each area
 * can answer without depending on this platform. That the two spellings agree is a
 * *cross-area* invariant and is asserted in
 * `tests/contract/operational-health.contract.test.ts` instead: importing the jobs
 * area here would make background jobs a dependency of the health platform, which
 * is exactly what the boundary rules forbid.
 */
const { HEALTH_CODE, HEALTH_CODES, isHealthCode } =
  await import("./health-code");

describe("the code set", () => {
  it("publishes exactly the documented codes", () => {
    expect([...HEALTH_CODES].sort()).toEqual([
      "DATABASE_UNAVAILABLE",
      "JOBS_REDIS_UNAVAILABLE",
      "NOT_READY",
      "PROCESS_ALIVE",
      "READY",
      "REDIS_UNAVAILABLE",
      "STORAGE_MISCONFIGURED",
      "STORAGE_UNAVAILABLE",
      "WORKER_MISCONFIGURED",
      "WORKER_NOT_READY",
      "WORKER_READY",
    ]);
  });

  it("names every code after its own key", () => {
    for (const [key, value] of Object.entries(HEALTH_CODE)) {
      expect(value).toBe(key);
    }
  });

  it("uses only screaming snake case, with no provider name and no prose", () => {
    for (const code of HEALTH_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);
      expect(code).not.toMatch(/\s/);
    }

    const joined = HEALTH_CODES.join(" ").toLowerCase();

    for (const forbidden of [
      "prisma",
      "postgres",
      "postgresql",
      "bullmq",
      "ioredis",
      "aws",
      "s3",
      "minio",
      "bucket",
      "econnrefused",
      "error",
      "exception",
      "failed to",
      "please",
    ]) {
      expect(joined, forbidden).not.toContain(forbidden);
    }
  });

  it("contains no duplicate value", () => {
    expect(new Set(HEALTH_CODES).size).toBe(HEALTH_CODES.length);
  });

  it("is frozen, so a caller cannot widen the published set at runtime", () => {
    expect(Object.isFrozen(HEALTH_CODES)).toBe(true);
  });
});

describe("isHealthCode", () => {
  it("accepts every published code", () => {
    for (const code of HEALTH_CODES) {
      expect(isHealthCode(code)).toBe(true);
    }
  });

  it.each([
    { name: "a lowercase spelling", value: "ready" },
    { name: "an unknown code", value: "DATABASE_SLOW" },
    { name: "a driver message", value: "ECONNREFUSED 10.1.2.3:5432" },
    { name: "an empty string", value: "" },
    { name: "a number", value: 503 },
    { name: "null", value: null },
    { name: "undefined", value: undefined },
    { name: "an object", value: { code: "READY" } },
  ])("refuses $name", ({ value }) => {
    expect(isHealthCode(value)).toBe(false);
  });
});
