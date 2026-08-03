import { afterEach, describe, expect, it, vi } from "vitest";

import type { DependencyCheck, DependencyReport } from "./dependency-check";

const { runHealthChecks } = await import("./run-health-checks.server");
const { createHealthRegistry } = await import("./health-registry");
const {
  DEPENDENCY_FAILURE_CODE,
  DEPENDENCY_NAME,
  DISABLED_DEPENDENCY,
  HEALTHY_DEPENDENCY,
  unhealthyDependency,
} = await import("./dependency-check");
const { HEALTH_CODE } = await import("./health-code");
const { DEPENDENCY_STATUS } = await import("./health-status");

/**
 * The orchestration.
 *
 * Two properties are the whole point of the module, and both are tested against
 * checks that misbehave in every way a real one can: rejecting, throwing
 * synchronously, and never settling.
 *
 * Containment — nothing reaches the caller. Bounding — each check has its own
 * deadline, so a slow optional dependency cannot consume the budget a required
 * one needed, and the timer is cleared on every path.
 */
function check(overrides: Partial<DependencyCheck> = {}): DependencyCheck {
  return {
    name: DEPENDENCY_NAME.DATABASE,
    timeoutMs: 1_000,
    failureCode: DEPENDENCY_FAILURE_CODE.DATABASE,
    run: async () => HEALTHY_DEPENDENCY,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("results", () => {
  it("returns one result per check, in registry order", async () => {
    const results = await runHealthChecks(
      createHealthRegistry([
        check({ name: DEPENDENCY_NAME.DATABASE }),
        check({
          name: DEPENDENCY_NAME.REDIS,
          failureCode: DEPENDENCY_FAILURE_CODE.REDIS,
          run: async () => DISABLED_DEPENDENCY,
        }),
        check({
          name: DEPENDENCY_NAME.STORAGE,
          failureCode: DEPENDENCY_FAILURE_CODE.STORAGE,
          run: async () =>
            unhealthyDependency(HEALTH_CODE.STORAGE_MISCONFIGURED),
        }),
      ]),
    );

    expect(results.map((result) => result.name)).toEqual([
      "database",
      "redis",
      "storage",
    ]);
    expect(results.map((result) => result.report.status)).toEqual([
      DEPENDENCY_STATUS.HEALTHY,
      DEPENDENCY_STATUS.DISABLED,
      DEPENDENCY_STATUS.UNHEALTHY,
    ]);
  });

  it("carries a duration on every result, including a failing one", async () => {
    const results = await runHealthChecks(
      createHealthRegistry([
        check(),
        check({
          name: DEPENDENCY_NAME.REDIS,
          failureCode: DEPENDENCY_FAILURE_CODE.REDIS,
          run: async () => {
            throw new Error("no");
          },
        }),
      ]),
    );

    for (const result of results) {
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.durationMs)).toBe(true);
    }
  });

  it("keeps the duration out of the report the response is built from", async () => {
    const [result] = await runHealthChecks(createHealthRegistry([check()]));

    expect(result?.report).not.toHaveProperty("durationMs");
    expect(result?.report).not.toHaveProperty("latencyMs");
  });

  it("runs the checks concurrently rather than one after another", async () => {
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const registry = createHealthRegistry([
      check({
        name: DEPENDENCY_NAME.DATABASE,
        run: async () => {
          started.push("database");

          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });

          return HEALTHY_DEPENDENCY;
        },
      }),
      check({
        name: DEPENDENCY_NAME.REDIS,
        failureCode: DEPENDENCY_FAILURE_CODE.REDIS,
        run: async () => {
          started.push("redis");
          releaseFirst?.();

          return HEALTHY_DEPENDENCY;
        },
      }),
    ]);

    // The second check would never start if the first were awaited to completion
    // before it, so this resolving at all is the assertion.
    await expect(runHealthChecks(registry)).resolves.toHaveLength(2);
    expect(started).toEqual(["database", "redis"]);
  });
});

describe("containment", () => {
  it.each([
    {
      name: "a rejecting check",
      run: async (): Promise<DependencyReport> => {
        throw new Error("connect ECONNREFUSED 10.1.2.3:5432");
      },
    },
    {
      name: "a check that throws synchronously",
      run: (): Promise<DependencyReport> => {
        throw new Error("the pool is closed");
      },
    },
    {
      name: "a check that rejects with a non-Error",
      run: (): Promise<DependencyReport> =>
        Promise.reject({ code: "P1001", host: "db.internal" }),
    },
  ])("converts $name into the declared code", async ({ run }) => {
    const results = await runHealthChecks(
      createHealthRegistry([
        check({
          name: DEPENDENCY_NAME.STORAGE,
          failureCode: DEPENDENCY_FAILURE_CODE.STORAGE,
          run,
        }),
      ]),
    );

    expect(results[0]?.report).toEqual({
      status: DEPENDENCY_STATUS.UNHEALTHY,
      code: HEALTH_CODE.STORAGE_UNAVAILABLE,
    });
  });

  it("leaks nothing from a thrown value into the result", async () => {
    const results = await runHealthChecks(
      createHealthRegistry([
        check({
          run: async () => {
            throw new Error(
              "password authentication failed for user app at db.internal:5432",
            );
          },
        }),
      ]),
    );

    const serialized = JSON.stringify(results[0]?.report);

    for (const forbidden of [
      "password",
      "db.internal",
      "5432",
      "authentication",
      "message",
      "stack",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("never rejects, whatever every check does", async () => {
    await expect(
      runHealthChecks(
        createHealthRegistry([
          check({
            run: async () => {
              throw new Error("one");
            },
          }),
          check({
            name: DEPENDENCY_NAME.REDIS,
            failureCode: DEPENDENCY_FAILURE_CODE.REDIS,
            run: () => Promise.reject(new Error("two")),
          }),
        ]),
      ),
    ).resolves.toHaveLength(2);
  });

  it("reports the failing check without discarding the healthy ones", async () => {
    const results = await runHealthChecks(
      createHealthRegistry([
        check({ name: DEPENDENCY_NAME.DATABASE }),
        check({
          name: DEPENDENCY_NAME.REDIS,
          failureCode: DEPENDENCY_FAILURE_CODE.REDIS,
          run: async () => {
            throw new Error("no");
          },
        }),
        check({
          name: DEPENDENCY_NAME.STORAGE,
          failureCode: DEPENDENCY_FAILURE_CODE.STORAGE,
          run: async () => DISABLED_DEPENDENCY,
        }),
      ]),
    );

    expect(results.map((result) => result.report.status)).toEqual([
      DEPENDENCY_STATUS.HEALTHY,
      DEPENDENCY_STATUS.UNHEALTHY,
      DEPENDENCY_STATUS.DISABLED,
    ]);
  });

  it("reports several simultaneous failures independently", async () => {
    const results = await runHealthChecks(
      createHealthRegistry([
        check({
          name: DEPENDENCY_NAME.DATABASE,
          run: async () => {
            throw new Error("no");
          },
        }),
        check({
          name: DEPENDENCY_NAME.REDIS,
          failureCode: DEPENDENCY_FAILURE_CODE.REDIS,
          run: async () => {
            throw new Error("no");
          },
        }),
        check({
          name: DEPENDENCY_NAME.STORAGE,
          failureCode: DEPENDENCY_FAILURE_CODE.STORAGE,
          run: async () =>
            unhealthyDependency(HEALTH_CODE.STORAGE_MISCONFIGURED),
        }),
      ]),
    );

    expect(results.map((result) => result.report)).toEqual([
      {
        status: DEPENDENCY_STATUS.UNHEALTHY,
        code: HEALTH_CODE.DATABASE_UNAVAILABLE,
      },
      {
        status: DEPENDENCY_STATUS.UNHEALTHY,
        code: HEALTH_CODE.REDIS_UNAVAILABLE,
      },
      {
        status: DEPENDENCY_STATUS.UNHEALTHY,
        code: HEALTH_CODE.STORAGE_MISCONFIGURED,
      },
    ]);
  });
});

describe("bounding", () => {
  it("times a hanging check out with its own declared code", async () => {
    vi.useFakeTimers();

    const pending = runHealthChecks(
      createHealthRegistry([
        check({
          name: DEPENDENCY_NAME.REDIS,
          timeoutMs: 1_500,
          failureCode: DEPENDENCY_FAILURE_CODE.REDIS,
          run: () => new Promise(() => undefined),
        }),
      ]),
    );

    await vi.advanceTimersByTimeAsync(1_501);

    await expect(pending).resolves.toEqual([
      expect.objectContaining({
        name: DEPENDENCY_NAME.REDIS,
        report: {
          status: DEPENDENCY_STATUS.UNHEALTHY,
          code: HEALTH_CODE.REDIS_UNAVAILABLE,
        },
      }),
    ]);
  });

  it("gives each check its own deadline rather than sharing one", async () => {
    vi.useFakeTimers();

    const pending = runHealthChecks(
      createHealthRegistry([
        // A required dependency with a short budget alongside an optional one that
        // never answers. A shared deadline would fail the first as well.
        check({ name: DEPENDENCY_NAME.DATABASE, timeoutMs: 200 }),
        check({
          name: DEPENDENCY_NAME.STORAGE,
          timeoutMs: 3_000,
          failureCode: DEPENDENCY_FAILURE_CODE.STORAGE,
          run: () => new Promise(() => undefined),
        }),
      ]),
    );

    await vi.advanceTimersByTimeAsync(3_001);

    const results = await pending;

    expect(results[0]?.report.status).toBe(DEPENDENCY_STATUS.HEALTHY);
    expect(results[1]?.report.status).toBe(DEPENDENCY_STATUS.UNHEALTHY);
  });

  it("clears every timer it created on the successful path", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await runHealthChecks(
      createHealthRegistry([
        check({ name: DEPENDENCY_NAME.DATABASE }),
        check({
          name: DEPENDENCY_NAME.REDIS,
          failureCode: DEPENDENCY_FAILURE_CODE.REDIS,
        }),
      ]),
    );

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
    clearTimeoutSpy.mockRestore();
  });

  it("clears every timer it created on the failing path", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await runHealthChecks(
      createHealthRegistry([
        check({
          run: async () => {
            throw new Error("no");
          },
        }),
        check({
          name: DEPENDENCY_NAME.REDIS,
          failureCode: DEPENDENCY_FAILURE_CODE.REDIS,
          run: () => Promise.reject(new Error("no")),
        }),
      ]),
    );

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
    clearTimeoutSpy.mockRestore();
  });

  it("leaves no pending timer behind after a timeout", async () => {
    vi.useFakeTimers();

    const pending = runHealthChecks(
      createHealthRegistry([
        check({
          timeoutMs: 500,
          run: () => new Promise(() => undefined),
        }),
      ]),
    );

    await vi.advanceTimersByTimeAsync(501);
    await pending;

    expect(vi.getTimerCount()).toBe(0);
  });
});
