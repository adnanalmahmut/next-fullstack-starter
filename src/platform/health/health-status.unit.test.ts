import { describe, expect, it } from "vitest";

const {
  DEPENDENCY_STATUS,
  HEALTH_PROCESS,
  LIVENESS_STATUS,
  READINESS_STATUS,
  WORKER_READINESS_STATUS,
} = await import("./health-status");

/**
 * The status vocabularies.
 *
 * Each is a wire value, so the tests are about the exact strings and about the
 * shape of each set — in particular that liveness has one answer and that the
 * worker's extra `misconfigured` state exists while the web's does not.
 */
describe("liveness", () => {
  it("has exactly one status", () => {
    expect(Object.values(LIVENESS_STATUS)).toEqual(["live"]);
  });
});

describe("readiness", () => {
  it("has exactly two statuses", () => {
    expect(Object.values(READINESS_STATUS).sort()).toEqual([
      "not_ready",
      "ready",
    ]);
  });

  it("has no misconfigured state, unlike the worker", () => {
    // A web process with a missing optional variable still serves requests, so
    // there is nothing for the status to say. A storage misconfiguration is
    // reported as unhealthy with a code instead.
    expect(Object.values(READINESS_STATUS)).not.toContain("misconfigured");
  });
});

describe("dependencies", () => {
  it("has exactly three statuses", () => {
    expect(Object.values(DEPENDENCY_STATUS).sort()).toEqual([
      "disabled",
      "healthy",
      "unhealthy",
    ]);
  });

  it("keeps disabled distinct from unhealthy", () => {
    // The single rule that makes every optional dependency genuinely optional.
    expect(DEPENDENCY_STATUS.DISABLED).not.toBe(DEPENDENCY_STATUS.UNHEALTHY);
  });
});

describe("worker readiness", () => {
  it("has exactly three statuses, including misconfigured", () => {
    expect(Object.values(WORKER_READINESS_STATUS).sort()).toEqual([
      "misconfigured",
      "not_ready",
      "ready",
    ]);
  });

  it("shares the ready and not-ready spellings with the web contract", () => {
    expect(WORKER_READINESS_STATUS.READY).toBe(READINESS_STATUS.READY);
    expect(WORKER_READINESS_STATUS.NOT_READY).toBe(READINESS_STATUS.NOT_READY);
  });
});

describe("processes", () => {
  it("names the two processes that report health", () => {
    expect(Object.values(HEALTH_PROCESS).sort()).toEqual(["web", "worker"]);
  });
});

describe("every vocabulary", () => {
  it.each([
    { name: "liveness", values: Object.values(LIVENESS_STATUS) },
    { name: "readiness", values: Object.values(READINESS_STATUS) },
    { name: "dependency", values: Object.values(DEPENDENCY_STATUS) },
    {
      name: "worker readiness",
      values: Object.values(WORKER_READINESS_STATUS),
    },
    { name: "process", values: Object.values(HEALTH_PROCESS) },
  ])("uses lowercase machine values for $name", ({ values }) => {
    for (const value of values) {
      expect(value).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
    }

    expect(new Set(values).size).toBe(values.length);
  });
});
