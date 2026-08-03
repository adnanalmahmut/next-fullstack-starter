import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerReadinessInput } from "./worker-readiness.server";

const info = vi.hoisted(() => vi.fn());
const error = vi.hoisted(() => vi.fn());

vi.mock("@/platform/observability/logger.server", () => {
  const silentLogger = {
    trace: () => undefined,
    debug: () => undefined,
    info,
    warn: () => undefined,
    error,
    fatal: () => undefined,
    child: () => silentLogger,
  };

  return {
    logger: silentLogger,
    createContextLogger: () => silentLogger,
    getRequestLogger: () => silentLogger,
  };
});

const {
  checkWorkerReadiness,
  logWorkerReadiness,
  WORKER_READINESS_TIMEOUT_MS,
} = await import("./worker-readiness.server");
const {
  DISABLED_DEPENDENCY,
  HEALTHY_DEPENDENCY,
  MAX_DEPENDENCY_TIMEOUT_MS,
  unhealthyDependency,
} = await import("./dependency-check");
const { HEALTH_CODE } = await import("./health-code");
const { DEPENDENCY_STATUS, HEALTH_PROCESS, WORKER_READINESS_STATUS } =
  await import("./health-status");

/**
 * The worker readiness contract.
 *
 * The checks are injected, so this suite needs no Redis, no queue, and no
 * database. That is the same property the production code relies on: the health
 * platform does not import `@/platform/jobs`, which is what keeps background jobs
 * deletable from a generated project.
 *
 * The distinction that earns most of these tests is `misconfigured` against
 * `not_ready`. It is what lets a supervisor stop restarting a worker that will
 * never start, and it is why `JOBS_ENABLED=false` is a failure here while being
 * entirely normal for the web process.
 */
function input(
  overrides: Partial<WorkerReadinessInput> = {},
): WorkerReadinessInput {
  return {
    jobsEnabled: true,
    queueConfigured: true,
    checkDatabase: async () => HEALTHY_DEPENDENCY,
    checkQueue: async () => HEALTHY_DEPENDENCY,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ready", () => {
  it("is ready when both dependencies answer", async () => {
    await expect(checkWorkerReadiness(input())).resolves.toEqual({
      process: HEALTH_PROCESS.WORKER,
      status: WORKER_READINESS_STATUS.READY,
      code: HEALTH_CODE.WORKER_READY,
      databaseStatus: DEPENDENCY_STATUS.HEALTHY,
      queueStatus: DEPENDENCY_STATUS.HEALTHY,
    });
  });

  it("carries exactly five fields, and no latency", async () => {
    const report = await checkWorkerReadiness(input());

    expect(Object.keys(report).sort()).toEqual([
      "code",
      "databaseStatus",
      "process",
      "queueStatus",
      "status",
    ]);
  });
});

describe("misconfigured", () => {
  it.each([
    { name: "JOBS_ENABLED is false", overrides: { jobsEnabled: false } },
    { name: "no queue address is set", overrides: { queueConfigured: false } },
    {
      name: "neither is set",
      overrides: { jobsEnabled: false, queueConfigured: false },
    },
  ])("is misconfigured when $name", async ({ overrides }) => {
    await expect(checkWorkerReadiness(input(overrides))).resolves.toEqual({
      process: HEALTH_PROCESS.WORKER,
      status: WORKER_READINESS_STATUS.MISCONFIGURED,
      code: HEALTH_CODE.WORKER_MISCONFIGURED,
      databaseStatus: DEPENDENCY_STATUS.DISABLED,
      queueStatus: DEPENDENCY_STATUS.DISABLED,
    });
  });

  it("opens no connection at all on that path", async () => {
    const checkDatabase = vi.fn(async () => HEALTHY_DEPENDENCY);
    const checkQueue = vi.fn(async () => HEALTHY_DEPENDENCY);

    await checkWorkerReadiness(
      input({ jobsEnabled: false, checkDatabase, checkQueue }),
    );

    // Nothing useful is learned from a database a misconfigured process will never
    // use, and a probe that connected anyway would be a probe that fails slowly.
    expect(checkDatabase).not.toHaveBeenCalled();
    expect(checkQueue).not.toHaveBeenCalled();
  });

  it("reports disabled rather than guessing at a status it never checked", async () => {
    const report = await checkWorkerReadiness(input({ jobsEnabled: false }));

    expect(report.databaseStatus).toBe(DEPENDENCY_STATUS.DISABLED);
    expect(report.queueStatus).toBe(DEPENDENCY_STATUS.DISABLED);
  });

  it("is a different verdict from not-ready, and a different code", () => {
    expect(WORKER_READINESS_STATUS.MISCONFIGURED).not.toBe(
      WORKER_READINESS_STATUS.NOT_READY,
    );
    expect(HEALTH_CODE.WORKER_MISCONFIGURED).not.toBe(
      HEALTH_CODE.WORKER_NOT_READY,
    );
  });
});

describe("not ready", () => {
  it("is not ready when the database will not answer", async () => {
    const report = await checkWorkerReadiness(
      input({
        checkDatabase: async () =>
          unhealthyDependency(HEALTH_CODE.DATABASE_UNAVAILABLE),
      }),
    );

    expect(report.status).toBe(WORKER_READINESS_STATUS.NOT_READY);
    expect(report.code).toBe(HEALTH_CODE.WORKER_NOT_READY);
    expect(report.databaseStatus).toBe(DEPENDENCY_STATUS.UNHEALTHY);
    expect(report.queueStatus).toBe(DEPENDENCY_STATUS.HEALTHY);
  });

  it("is not ready when the queue will not answer", async () => {
    const report = await checkWorkerReadiness(
      input({
        checkQueue: async () =>
          unhealthyDependency(HEALTH_CODE.JOBS_REDIS_UNAVAILABLE),
      }),
    );

    expect(report.status).toBe(WORKER_READINESS_STATUS.NOT_READY);
    expect(report.queueStatus).toBe(DEPENDENCY_STATUS.UNHEALTHY);
    expect(report.databaseStatus).toBe(DEPENDENCY_STATUS.HEALTHY);
  });

  it("is not ready when neither answers", async () => {
    const report = await checkWorkerReadiness(
      input({
        checkDatabase: async () =>
          unhealthyDependency(HEALTH_CODE.DATABASE_UNAVAILABLE),
        checkQueue: async () =>
          unhealthyDependency(HEALTH_CODE.JOBS_REDIS_UNAVAILABLE),
      }),
    );

    expect(report.status).toBe(WORKER_READINESS_STATUS.NOT_READY);
    expect(report.databaseStatus).toBe(DEPENDENCY_STATUS.UNHEALTHY);
    expect(report.queueStatus).toBe(DEPENDENCY_STATUS.UNHEALTHY);
  });

  it("is not ready when a configured queue reports itself disabled", async () => {
    // The configuration said there is a queue and the check disagrees. That is not
    // readiness, and treating it as one would report a worker that consumes
    // nothing as healthy.
    const report = await checkWorkerReadiness(
      input({ checkQueue: async () => DISABLED_DEPENDENCY }),
    );

    expect(report.status).toBe(WORKER_READINESS_STATUS.NOT_READY);
    expect(report.queueStatus).toBe(DEPENDENCY_STATUS.DISABLED);
  });
});

describe("containment", () => {
  it.each([
    {
      name: "a rejecting database check",
      overrides: {
        checkDatabase: async () => {
          throw new Error("Can't reach database server at db.internal:5432");
        },
      },
      expected: "databaseStatus" as const,
    },
    {
      name: "a rejecting queue check",
      overrides: {
        checkQueue: async () => {
          throw new Error("connect ECONNREFUSED 10.1.2.3:6379");
        },
      },
      expected: "queueStatus" as const,
    },
    {
      name: "a synchronously throwing check",
      overrides: {
        checkQueue: () => {
          throw new Error("the client is closed");
        },
      },
      expected: "queueStatus" as const,
    },
  ])(
    "converts $name into an unready verdict",
    async ({ overrides, expected }) => {
      const report = await checkWorkerReadiness(input(overrides));

      expect(report.status).toBe(WORKER_READINESS_STATUS.NOT_READY);
      expect(report[expected]).toBe(DEPENDENCY_STATUS.UNHEALTHY);
    },
  );

  it("never rejects", async () => {
    await expect(
      checkWorkerReadiness(
        input({
          checkDatabase: () => Promise.reject(new Error("one")),
          checkQueue: () => Promise.reject(new Error("two")),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("leaks nothing from a thrown value into the report", async () => {
    const report = await checkWorkerReadiness(
      input({
        checkQueue: async () => {
          throw new Error(
            "NOAUTH Authentication required at queue.internal:6379 (redis://admin:hunter2@queue.internal:6379)",
          );
        },
      }),
    );
    const serialized = JSON.stringify(report);

    for (const forbidden of [
      "hunter2",
      "queue.internal",
      "redis://",
      "NOAUTH",
      "6379",
      "message",
      "stack",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });
});

describe("bounding", () => {
  it("declares budgets within the platform ceiling", () => {
    for (const budget of Object.values(WORKER_READINESS_TIMEOUT_MS)) {
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(MAX_DEPENDENCY_TIMEOUT_MS);
    }
  });

  it("times a hanging check out rather than waiting forever", async () => {
    vi.useFakeTimers();

    const pending = checkWorkerReadiness(
      input({
        checkQueue: () => new Promise(() => undefined),
        queueTimeoutMs: 1_000,
      }),
    );

    await vi.advanceTimersByTimeAsync(1_001);

    const report = await pending;

    expect(report.status).toBe(WORKER_READINESS_STATUS.NOT_READY);
    expect(report.queueStatus).toBe(DEPENDENCY_STATUS.UNHEALTHY);
  });

  it.each([
    { name: "above the ceiling", value: MAX_DEPENDENCY_TIMEOUT_MS + 60_000 },
    { name: "below the floor", value: 1 },
    { name: "zero", value: 0 },
    { name: "negative", value: -500 },
    { name: "fractional", value: 1_500.5 },
    { name: "not a number", value: Number.NaN },
    { name: "infinite", value: Number.POSITIVE_INFINITY },
  ])(
    "answers rather than rejecting for a budget that is $name",
    async ({ value }) => {
      // A caller's budget is a preference, not a composition. The registry's own
      // validation stays strict — it catches a malformed registry — but a probe that
      // threw because somebody asked for one millisecond would be failing for a
      // reason unrelated to the thing it was asked about.
      await expect(
        checkWorkerReadiness(
          input({ databaseTimeoutMs: value, queueTimeoutMs: value }),
        ),
      ).resolves.toMatchObject({ status: WORKER_READINESS_STATUS.READY });
    },
  );

  it("clamps a tiny budget up rather than treating it as immediate", async () => {
    // Clamped to the floor, so the check gets a real chance to answer instead of
    // every dependency being reported unavailable under any load at all.
    const report = await checkWorkerReadiness(
      input({
        queueTimeoutMs: 1,
        checkQueue: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));

          return HEALTHY_DEPENDENCY;
        },
      }),
    );

    expect(report.status).toBe(WORKER_READINESS_STATUS.READY);
  });

  it("leaves no pending timer behind", async () => {
    vi.useFakeTimers();

    const pending = checkWorkerReadiness(
      input({
        checkQueue: () => new Promise(() => undefined),
        queueTimeoutMs: 500,
      }),
    );

    await vi.advanceTimersByTimeAsync(501);
    await pending;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs the two checks concurrently", async () => {
    const order: string[] = [];

    await checkWorkerReadiness(
      input({
        checkDatabase: async () => {
          order.push("database:start");
          await Promise.resolve();
          order.push("database:end");

          return HEALTHY_DEPENDENCY;
        },
        checkQueue: async () => {
          order.push("queue:start");

          return HEALTHY_DEPENDENCY;
        },
      }),
    );

    expect(order.indexOf("queue:start")).toBeLessThan(
      order.indexOf("database:end"),
    );
  });
});

describe("logging", () => {
  it("writes one info line for a ready worker", async () => {
    logWorkerReadiness(await checkWorkerReadiness(input()));

    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      {
        process: "worker",
        status: WORKER_READINESS_STATUS.READY,
        code: HEALTH_CODE.WORKER_READY,
        databaseStatus: DEPENDENCY_STATUS.HEALTHY,
        queueStatus: DEPENDENCY_STATUS.HEALTHY,
      },
      "health.worker.checked",
    );
  });

  it.each([
    {
      name: "an unready worker",
      overrides: {
        checkQueue: async () =>
          unhealthyDependency(HEALTH_CODE.JOBS_REDIS_UNAVAILABLE),
      },
    },
    { name: "a misconfigured worker", overrides: { jobsEnabled: false } },
  ])("writes one error line for $name", async ({ overrides }) => {
    logWorkerReadiness(await checkWorkerReadiness(input(overrides)));

    expect(error).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });

  it("writes only allowlisted fields", async () => {
    logWorkerReadiness(await checkWorkerReadiness(input()));

    const [payload] = info.mock.calls[0] ?? [];

    expect(Object.keys(payload as object).sort()).toEqual([
      "code",
      "databaseStatus",
      "process",
      "queueStatus",
      "status",
    ]);
  });

  it("uses no console", async () => {
    const consoleLog = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    logWorkerReadiness(
      await checkWorkerReadiness(input({ jobsEnabled: false })),
    );

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();

    consoleLog.mockRestore();
    consoleError.mockRestore();
  });
});
