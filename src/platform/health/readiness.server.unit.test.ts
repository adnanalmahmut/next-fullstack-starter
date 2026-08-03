import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DependencyCheck, DependencyReport } from "./dependency-check";

const connection = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock("next/server", () => ({
  connection: () => connection() as Promise<void>,
}));

vi.mock("@/platform/observability/logger.server", () => {
  const silentLogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn,
    error: () => undefined,
    fatal: () => undefined,
    child: () => silentLogger,
  };

  return {
    logger: silentLogger,
    createContextLogger: () => silentLogger,
    getRequestLogger: () => silentLogger,
  };
});

/**
 * The web composition is replaced, and only it.
 *
 * It is the one module in this directory that reaches `@/platform/database`,
 * `@/platform/redis`, and `@/platform/storage`, so importing it here would
 * construct a Prisma client for a test about a handler. Its own mapping is proved
 * in `web-readiness.server.unit.test.ts`, against the real platform contracts.
 */
vi.mock("./web-readiness.server", () => ({
  createWebReadinessRegistry: () => {
    throw new Error("not used by these tests");
  },
  toDatabaseReport: () => {
    throw new Error("not used by these tests");
  },
  toRedisReport: () => {
    throw new Error("not used by these tests");
  },
  toStorageReport: () => {
    throw new Error("not used by these tests");
  },
  WEB_READINESS_TIMEOUT_MS: { DATABASE: 2_000, REDIS: 1_500, STORAGE: 3_000 },
}));

const { createReadinessHandler } = await import("./readiness.server");
const { createHealthRegistry } = await import("./health-registry");
const {
  DEPENDENCY_FAILURE_CODE,
  DEPENDENCY_NAME,
  DISABLED_DEPENDENCY,
  HEALTHY_DEPENDENCY,
  unhealthyDependency,
} = await import("./dependency-check");
const { HEALTH_CODE } = await import("./health-code");
const { DEPENDENCY_STATUS, READINESS_STATUS } = await import("./health-status");

function check(overrides: Partial<DependencyCheck> = {}): DependencyCheck {
  return {
    name: DEPENDENCY_NAME.DATABASE,
    timeoutMs: 1_000,
    failureCode: DEPENDENCY_FAILURE_CODE.DATABASE,
    run: async () => HEALTHY_DEPENDENCY,
    ...overrides,
  };
}

function registryOf(
  database: DependencyReport,
  redis: DependencyReport,
  storage: DependencyReport,
) {
  return createHealthRegistry([
    check({ name: DEPENDENCY_NAME.DATABASE, run: async () => database }),
    check({
      name: DEPENDENCY_NAME.REDIS,
      failureCode: DEPENDENCY_FAILURE_CODE.REDIS,
      run: async () => redis,
    }),
    check({
      name: DEPENDENCY_NAME.STORAGE,
      failureCode: DEPENDENCY_FAILURE_CODE.STORAGE,
      run: async () => storage,
    }),
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  connection.mockResolvedValue(undefined);
});

describe("ready", () => {
  it("answers 200 with the whole document", async () => {
    const response = await createReadinessHandler(
      registryOf(HEALTHY_DEPENDENCY, DISABLED_DEPENDENCY, DISABLED_DEPENDENCY),
    )();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: READINESS_STATUS.READY,
      code: HEALTH_CODE.READY,
      checks: {
        database: { status: DEPENDENCY_STATUS.HEALTHY },
        redis: { status: DEPENDENCY_STATUS.DISABLED },
        storage: { status: DEPENDENCY_STATUS.DISABLED },
      },
    });
  });

  it("sets no-store", async () => {
    const response = await createReadinessHandler(
      registryOf(HEALTHY_DEPENDENCY, HEALTHY_DEPENDENCY, HEALTHY_DEPENDENCY),
    )();

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("writes no log line", async () => {
    await createReadinessHandler(
      registryOf(HEALTHY_DEPENDENCY, DISABLED_DEPENDENCY, DISABLED_DEPENDENCY),
    )();

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("not ready", () => {
  it("answers 503 with the failing dependency named", async () => {
    const response = await createReadinessHandler(
      registryOf(
        unhealthyDependency(HEALTH_CODE.DATABASE_UNAVAILABLE),
        HEALTHY_DEPENDENCY,
        DISABLED_DEPENDENCY,
      ),
    )();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: READINESS_STATUS.NOT_READY,
      code: HEALTH_CODE.NOT_READY,
      checks: {
        database: {
          status: DEPENDENCY_STATUS.UNHEALTHY,
          code: HEALTH_CODE.DATABASE_UNAVAILABLE,
        },
        redis: { status: DEPENDENCY_STATUS.HEALTHY },
        storage: { status: DEPENDENCY_STATUS.DISABLED },
      },
    });
  });

  it("sets no-store on a 503 as well", async () => {
    const response = await createReadinessHandler(
      registryOf(
        unhealthyDependency(HEALTH_CODE.DATABASE_UNAVAILABLE),
        DISABLED_DEPENDENCY,
        DISABLED_DEPENDENCY,
      ),
    )();

    // A cached 503 keeps traffic away from an instance that recovered a minute
    // ago, which is the more damaging half of the caching problem.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 503 when an enabled optional dependency is unhealthy", async () => {
    const response = await createReadinessHandler(
      registryOf(
        HEALTHY_DEPENDENCY,
        unhealthyDependency(HEALTH_CODE.REDIS_UNAVAILABLE),
        DISABLED_DEPENDENCY,
      ),
    )();

    expect(response.status).toBe(503);
  });

  it("answers 503 for a misconfigured object store, with its own code", async () => {
    const response = await createReadinessHandler(
      registryOf(
        HEALTHY_DEPENDENCY,
        DISABLED_DEPENDENCY,
        unhealthyDependency(HEALTH_CODE.STORAGE_MISCONFIGURED),
      ),
    )();
    const body = (await response.json()) as { checks: Record<string, unknown> };

    expect(response.status).toBe(503);
    expect(body.checks.storage).toEqual({
      status: DEPENDENCY_STATUS.UNHEALTHY,
      code: HEALTH_CODE.STORAGE_MISCONFIGURED,
    });
  });

  it("writes one warning line carrying every dependency status", async () => {
    await createReadinessHandler(
      registryOf(
        unhealthyDependency(HEALTH_CODE.DATABASE_UNAVAILABLE),
        DISABLED_DEPENDENCY,
        HEALTHY_DEPENDENCY,
      ),
    )();

    expect(warn).toHaveBeenCalledTimes(1);

    const [payload, event] = warn.mock.calls[0] ?? [];

    expect(event).toBe("health.readiness.failed");
    expect(payload).toMatchObject({
      process: "web",
      status: READINESS_STATUS.NOT_READY,
      code: HEALTH_CODE.NOT_READY,
      databaseStatus: DEPENDENCY_STATUS.UNHEALTHY,
      redisStatus: DEPENDENCY_STATUS.DISABLED,
      storageStatus: DEPENDENCY_STATUS.HEALTHY,
    });
  });

  it("keeps the latency in the log line and out of the body", async () => {
    const response = await createReadinessHandler(
      registryOf(
        unhealthyDependency(HEALTH_CODE.DATABASE_UNAVAILABLE),
        DISABLED_DEPENDENCY,
        DISABLED_DEPENDENCY,
      ),
    )();

    const [payload] = warn.mock.calls[0] ?? [];

    expect(payload).toHaveProperty("durationMs");
    expect(await response.text()).not.toContain("durationMs");
  });
});

describe("containment", () => {
  it("answers 503 rather than propagating when a check throws", async () => {
    const response = await createReadinessHandler(
      registryOf(HEALTHY_DEPENDENCY, DISABLED_DEPENDENCY, DISABLED_DEPENDENCY),
    );

    const failing = createReadinessHandler(
      createHealthRegistry([
        check({
          run: async () => {
            throw new Error("connect ECONNREFUSED 10.1.2.3:5432");
          },
        }),
      ]),
    );

    await expect(response()).resolves.toBeInstanceOf(Response);

    const failed = await failing();

    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("ECONNREFUSED");
  });

  it("answers the ordinary document when aggregation itself fails", async () => {
    // A logger that throws is the plausible version of this: the checks ran, the
    // verdict is known, and writing the line is what broke.
    warn.mockImplementation(() => {
      throw new Error("the transport is gone");
    });

    const response = await createReadinessHandler(
      registryOf(
        unhealthyDependency(HEALTH_CODE.DATABASE_UNAVAILABLE),
        DISABLED_DEPENDENCY,
        DISABLED_DEPENDENCY,
      ),
    )();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: READINESS_STATUS.NOT_READY,
      code: HEALTH_CODE.NOT_READY,
      checks: {},
    });
  });

  it("never rejects", async () => {
    warn.mockImplementation(() => {
      throw new Error("no");
    });

    await expect(
      createReadinessHandler(
        createHealthRegistry([
          check({
            run: () => Promise.reject(new Error("no")),
          }),
        ]),
      )(),
    ).resolves.toBeInstanceOf(Response);
  });

  it("leaks nothing from a thrown value into the body", async () => {
    const response = await createReadinessHandler(
      createHealthRegistry([
        check({
          run: async () => {
            throw new Error(
              "password authentication failed for app at db.internal:5432",
            );
          },
        }),
      ]),
    )();
    const body = await response.text();

    for (const forbidden of [
      "password",
      "db.internal",
      "5432",
      "authentication",
      "message",
      "stack",
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });
});

describe("request-time rendering", () => {
  it("waits for a request before running any check", async () => {
    const run = vi.fn(async () => HEALTHY_DEPENDENCY);
    let release: (() => void) | undefined;

    connection.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const pending = createReadinessHandler(
      createHealthRegistry([check({ run })]),
    )();

    await Promise.resolve();

    // This is the assertion that keeps `next build` from running the probes: at
    // build time `connection()` never resolves, so the checks never start.
    expect(run).not.toHaveBeenCalled();

    release?.();

    await pending;

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not call it while the handler is being built", () => {
    createReadinessHandler(createHealthRegistry([check()]));

    expect(connection).not.toHaveBeenCalled();
  });
});

describe("the registry", () => {
  it("is captured once and reused for every request", async () => {
    const run = vi.fn(async () => HEALTHY_DEPENDENCY);
    const handler = createReadinessHandler(
      createHealthRegistry([check({ run })]),
    );

    await handler();
    await handler();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("checks only what the registry declares", async () => {
    const response = await createReadinessHandler(
      createHealthRegistry([check({ name: DEPENDENCY_NAME.DATABASE })]),
    )();
    const body = (await response.json()) as { checks: Record<string, unknown> };

    // A web registry never declares the queue: a request records work by writing
    // an outbox row inside its own transaction.
    expect(Object.keys(body.checks)).toEqual(["database"]);
    expect(body.checks).not.toHaveProperty("queue");
  });
});
