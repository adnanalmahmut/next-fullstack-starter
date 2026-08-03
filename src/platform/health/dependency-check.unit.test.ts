import { describe, expect, it } from "vitest";

const {
  DEPENDENCY_FAILURE_CODE,
  DEPENDENCY_NAME,
  DEPENDENCY_NAMES,
  DISABLED_DEPENDENCY,
  HEALTHY_DEPENDENCY,
  isDependencyFailure,
  MAX_DEPENDENCY_TIMEOUT_MS,
  MIN_DEPENDENCY_TIMEOUT_MS,
  unhealthyDependency,
} = await import("./dependency-check");

const { HEALTH_CODE } = await import("./health-code");
const { DEPENDENCY_STATUS } = await import("./health-status");

/**
 * The dependency port.
 *
 * The properties worth asserting are about what a report *cannot* carry: a
 * healthy or disabled report has exactly one key, and an unhealthy one has
 * exactly two. That is the mechanism preventing a provider message reaching a
 * public probe response — there is nowhere in the value to put one.
 */
describe("names", () => {
  it("publishes exactly the four dependencies a process can check", () => {
    expect([...DEPENDENCY_NAMES].sort()).toEqual([
      "database",
      "queue",
      "redis",
      "storage",
    ]);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(DEPENDENCY_NAMES)).toBe(true);
  });

  it("names every dependency after its own key", () => {
    for (const [key, value] of Object.entries(DEPENDENCY_NAME)) {
      expect(value).toBe(key.toLowerCase());
    }
  });
});

describe("reports", () => {
  it("carries nothing at all when healthy", () => {
    expect(HEALTHY_DEPENDENCY).toEqual({
      status: DEPENDENCY_STATUS.HEALTHY,
    });
    expect(Object.keys(HEALTHY_DEPENDENCY)).toEqual(["status"]);
  });

  it("carries nothing at all when disabled", () => {
    expect(DISABLED_DEPENDENCY).toEqual({
      status: DEPENDENCY_STATUS.DISABLED,
    });
    expect(Object.keys(DISABLED_DEPENDENCY)).toEqual(["status"]);
  });

  it("carries a status and a code when unhealthy, and nothing else", () => {
    const report = unhealthyDependency(HEALTH_CODE.STORAGE_MISCONFIGURED);

    expect(report).toEqual({
      status: DEPENDENCY_STATUS.UNHEALTHY,
      code: HEALTH_CODE.STORAGE_MISCONFIGURED,
    });
    expect(Object.keys(report).sort()).toEqual(["code", "status"]);
  });

  it("freezes the two shared constants, which are handed to every response", () => {
    expect(Object.isFrozen(HEALTHY_DEPENDENCY)).toBe(true);
    expect(Object.isFrozen(DISABLED_DEPENDENCY)).toBe(true);
  });

  it("has no field for a message, a latency, or a provider detail", () => {
    const reports = [
      HEALTHY_DEPENDENCY,
      DISABLED_DEPENDENCY,
      unhealthyDependency(HEALTH_CODE.REDIS_UNAVAILABLE),
    ];

    for (const report of reports) {
      for (const forbidden of [
        "message",
        "latencyMs",
        "durationMs",
        "endpoint",
        "bucket",
        "host",
        "url",
        "stack",
        "detail",
      ]) {
        expect(report, forbidden).not.toHaveProperty(forbidden);
      }
    }
  });
});

describe("isDependencyFailure", () => {
  it("treats an unhealthy report as a failure", () => {
    expect(
      isDependencyFailure(
        unhealthyDependency(HEALTH_CODE.DATABASE_UNAVAILABLE),
      ),
    ).toBe(true);
  });

  it("never treats a disabled dependency as a failure", () => {
    // The one rule that keeps an optional dependency optional. A deployment that
    // caches nothing and stores nothing is supported, not degraded.
    expect(isDependencyFailure(DISABLED_DEPENDENCY)).toBe(false);
  });

  it("never treats a healthy dependency as a failure", () => {
    expect(isDependencyFailure(HEALTHY_DEPENDENCY)).toBe(false);
  });
});

describe("timeout bounds", () => {
  it("declares a floor and a ceiling that leave room for a real call", () => {
    expect(MIN_DEPENDENCY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(MAX_DEPENDENCY_TIMEOUT_MS).toBeGreaterThan(
      MIN_DEPENDENCY_TIMEOUT_MS,
    );
    expect(MAX_DEPENDENCY_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("failure codes", () => {
  it("gives every dependency a published code", () => {
    expect(DEPENDENCY_FAILURE_CODE).toEqual({
      DATABASE: HEALTH_CODE.DATABASE_UNAVAILABLE,
      REDIS: HEALTH_CODE.REDIS_UNAVAILABLE,
      STORAGE: HEALTH_CODE.STORAGE_UNAVAILABLE,
      QUEUE: HEALTH_CODE.JOBS_REDIS_UNAVAILABLE,
    });
  });

  it("covers every dependency name", () => {
    expect(
      Object.keys(DEPENDENCY_FAILURE_CODE)
        .map((key) => key.toLowerCase())
        .sort(),
    ).toEqual([...DEPENDENCY_NAMES].sort());
  });
});
