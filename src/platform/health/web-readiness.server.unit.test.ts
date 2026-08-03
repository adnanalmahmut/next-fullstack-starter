import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.hoisted(() => vi.fn());
const createClient = vi.hoisted(() => vi.fn());
const getStorageProvider = vi.hoisted(() => vi.fn());
const requireStorageProvider = vi.hoisted(() => vi.fn());
const closeStorageClient = vi.hoisted(() => vi.fn());

/**
 * Only the three client constructors are replaced.
 *
 * Everything above them is real: the real `checkDatabaseHealth`, the real
 * `checkRedisHealth`, the real `checkStorageHealth`, the real status constants,
 * and the real mappers. That matters, because the property under test is that
 * three independently designed health contracts are translated into one probe
 * vocabulary without a case being missed — and a test that mocked the health
 * functions would be asserting its own idea of what they return.
 */
vi.mock("@/platform/database/prisma", () => ({
  database: {
    $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) =>
      queryRaw(query, ...values) as unknown,
  },
}));

vi.mock("redis", () => ({
  createClient: (options: unknown) => createClient(options) as unknown,
}));

vi.mock("@/platform/storage/provider/storage-client.server", () => ({
  getStorageProvider,
  requireStorageProvider,
  closeStorageClient,
}));

vi.mock("@/platform/observability/logger.server", () => {
  const silentLogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
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

const {
  createWebReadinessRegistry,
  toDatabaseReport,
  toRedisReport,
  toStorageReport,
  WEB_READINESS_TIMEOUT_MS,
} = await import("./web-readiness.server");

const { runHealthChecks } = await import("./run-health-checks.server");
const { httpStatusForReadiness, toReadinessReport } =
  await import("./readiness");
const { DEPENDENCY_NAME, MAX_DEPENDENCY_TIMEOUT_MS } =
  await import("./dependency-check");
const { HEALTH_CODE, HEALTH_CODES } = await import("./health-code");
const { DEPENDENCY_STATUS, READINESS_STATUS } = await import("./health-status");

// Reached through each area's controlled entry point, never through a file inside
// it: the health platform is bound by the same boundaries as any other consumer.
const { DATABASE_HEALTH_STATUS } =
  await import("@/platform/database/index.server");
const { REDIS_HEALTH_STATUS, resetRedisConfiguration } =
  await import("@/platform/redis/index.server");
const { STORAGE_HEALTH_STATUS, resetStorageConfiguration } =
  await import("@/platform/storage/index.server");

const MANAGED_VARIABLES = [
  "REDIS_ENABLED",
  "REDIS_URL",
  "REDIS_CONNECT_TIMEOUT_MS",
  "STORAGE_ENABLED",
  "STORAGE_REGION",
  "STORAGE_BUCKET",
  "STORAGE_ENDPOINT",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
] as const;

const saved = new Map<string, string | undefined>();

function set(name: string, value: string): void {
  process.env[name] = value;
}

function enableRedis(): void {
  set("REDIS_ENABLED", "true");
  set("REDIS_URL", "redis://admin:hunter2@cache.internal:6379");
  set("REDIS_CONNECT_TIMEOUT_MS", "200");
  resetRedisConfiguration();
}

function enableStorage(): void {
  set("STORAGE_ENABLED", "true");
  set("STORAGE_REGION", "eu-west-1");
  set("STORAGE_BUCKET", "customer-documents");
  set("STORAGE_ENDPOINT", "https://objects.internal");
  set("STORAGE_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
  set("STORAGE_SECRET_ACCESS_KEY", "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY");
  resetStorageConfiguration();
}

function healthyRedisClient() {
  return {
    isOpen: false,
    isReady: false,
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    ping: vi.fn().mockResolvedValue("PONG"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  for (const name of MANAGED_VARIABLES) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }

  resetRedisConfiguration();
  resetStorageConfiguration();

  queryRaw.mockResolvedValue([{ value: 1 }]);
  createClient.mockReturnValue(healthyRedisClient());
  getStorageProvider.mockReturnValue({
    checkBucket: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(async () => {
  const { closeRedisClient } = await import("@/platform/redis/index.server");

  await closeRedisClient();

  for (const [name, value] of saved) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  saved.clear();
  resetRedisConfiguration();
  resetStorageConfiguration();
});

describe("the registry", () => {
  it("declares exactly the three dependencies a web process has", () => {
    expect(createWebReadinessRegistry().names).toEqual([
      "database",
      "redis",
      "storage",
    ]);
  });

  it("never declares the queue", () => {
    // A request records work by writing an outbox row inside its own transaction,
    // so a web instance with no worker anywhere is ready. Checking the queue here
    // would drain traffic from instances that were serving perfectly.
    expect(createWebReadinessRegistry().names).not.toContain(
      DEPENDENCY_NAME.QUEUE,
    );
  });

  it("gives each dependency its own bounded budget", () => {
    const registry = createWebReadinessRegistry();
    const budgets = registry.checks.map((check) => check.timeoutMs);

    expect(new Set(budgets).size).toBe(budgets.length);

    for (const budget of budgets) {
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(MAX_DEPENDENCY_TIMEOUT_MS);
    }

    expect(WEB_READINESS_TIMEOUT_MS.DATABASE).toBeLessThan(
      WEB_READINESS_TIMEOUT_MS.STORAGE,
    );
  });

  it("declares the published failure code for each dependency", () => {
    expect(
      createWebReadinessRegistry().checks.map((check) => check.failureCode),
    ).toEqual([
      HEALTH_CODE.DATABASE_UNAVAILABLE,
      HEALTH_CODE.REDIS_UNAVAILABLE,
      HEALTH_CODE.STORAGE_UNAVAILABLE,
    ]);
  });

  it("runs no check and builds no client while being constructed", () => {
    createWebReadinessRegistry();

    expect(queryRaw).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(getStorageProvider).not.toHaveBeenCalled();
  });

  it("builds an independent value on each call", () => {
    const first = createWebReadinessRegistry();
    const second = createWebReadinessRegistry();

    expect(first).not.toBe(second);
    expect(first.names).toEqual(second.names);
  });
});

describe("the database mapping", () => {
  it("maps healthy to healthy, dropping the latency", () => {
    expect(
      toDatabaseReport({
        status: DATABASE_HEALTH_STATUS.HEALTHY,
        latencyMs: 4,
      }),
    ).toEqual({ status: DEPENDENCY_STATUS.HEALTHY });
  });

  it("maps unhealthy to the published code", () => {
    expect(
      toDatabaseReport({
        status: DATABASE_HEALTH_STATUS.UNHEALTHY,
        code: "DATABASE_UNAVAILABLE",
      }),
    ).toEqual({
      status: DEPENDENCY_STATUS.UNHEALTHY,
      code: HEALTH_CODE.DATABASE_UNAVAILABLE,
    });
  });

  it("has no disabled case, because PostgreSQL is not optional", () => {
    const statuses = Object.values(DATABASE_HEALTH_STATUS);

    expect(statuses).not.toContain(DEPENDENCY_STATUS.DISABLED);
  });
});

describe("the Redis mapping", () => {
  it("maps disabled to disabled, which is not a failure", () => {
    expect(toRedisReport({ status: REDIS_HEALTH_STATUS.DISABLED })).toEqual({
      status: DEPENDENCY_STATUS.DISABLED,
    });
  });

  it("maps healthy to healthy, dropping the latency", () => {
    expect(
      toRedisReport({ status: REDIS_HEALTH_STATUS.HEALTHY, latencyMs: 2 }),
    ).toEqual({ status: DEPENDENCY_STATUS.HEALTHY });
  });

  it("maps unhealthy to the published code", () => {
    expect(
      toRedisReport({
        status: REDIS_HEALTH_STATUS.UNHEALTHY,
        code: "REDIS_UNAVAILABLE",
      }),
    ).toEqual({
      status: DEPENDENCY_STATUS.UNHEALTHY,
      code: HEALTH_CODE.REDIS_UNAVAILABLE,
    });
  });
});

describe("the storage mapping", () => {
  it("maps disabled to disabled, which is not a failure", () => {
    expect(toStorageReport({ status: STORAGE_HEALTH_STATUS.DISABLED })).toEqual(
      {
        status: DEPENDENCY_STATUS.DISABLED,
      },
    );
  });

  it("maps healthy to healthy, dropping the latency", () => {
    expect(
      toStorageReport({ status: STORAGE_HEALTH_STATUS.HEALTHY, latencyMs: 9 }),
    ).toEqual({ status: DEPENDENCY_STATUS.HEALTHY });
  });

  it("maps unavailable to the retryable code", () => {
    expect(
      toStorageReport({ status: STORAGE_HEALTH_STATUS.UNAVAILABLE }),
    ).toEqual({
      status: DEPENDENCY_STATUS.UNHEALTHY,
      code: HEALTH_CODE.STORAGE_UNAVAILABLE,
    });
  });

  it("maps misconfigured to its own code, kept distinct from unavailable", () => {
    // One says wait, the other says somebody has to deploy a fix. Collapsing them
    // would hide that difference from whoever is reading the probe.
    expect(
      toStorageReport({ status: STORAGE_HEALTH_STATUS.MISCONFIGURED }),
    ).toEqual({
      status: DEPENDENCY_STATUS.UNHEALTHY,
      code: HEALTH_CODE.STORAGE_MISCONFIGURED,
    });

    expect(HEALTH_CODE.STORAGE_MISCONFIGURED).not.toBe(
      HEALTH_CODE.STORAGE_UNAVAILABLE,
    );
  });

  it("covers every status the storage platform can answer", () => {
    for (const status of Object.values(STORAGE_HEALTH_STATUS)) {
      const report = toStorageReport({ status, latencyMs: 1 } as never);

      expect(Object.values(DEPENDENCY_STATUS), status).toContain(report.status);
    }
  });
});

/**
 * The whole readiness matrix, in one table, through the real platform contracts.
 *
 * The individual cases below each say something extra about sanitization or about
 * which clients were built. This table says the one thing that has to hold across
 * every combination: the HTTP status follows from the checks and nothing else.
 */
describe("the readiness matrix", () => {
  type Mode = "disabled" | "healthy" | "unavailable" | "misconfigured";

  function applyDatabase(healthy: boolean): void {
    if (healthy) {
      queryRaw.mockResolvedValue([{ value: 1 }]);
    } else {
      queryRaw.mockRejectedValue(new Error("unreachable"));
    }
  }

  function applyRedis(mode: Mode): void {
    if (mode === "disabled") {
      return;
    }

    enableRedis();

    createClient.mockReturnValue(
      mode === "healthy"
        ? healthyRedisClient()
        : {
            ...healthyRedisClient(),
            connect: vi.fn().mockRejectedValue(new Error("refused")),
          },
    );
  }

  function applyStorage(mode: Mode): void {
    if (mode === "disabled") {
      return;
    }

    enableStorage();

    if (mode === "healthy") {
      getStorageProvider.mockReturnValue({
        checkBucket: vi.fn().mockResolvedValue(undefined),
      });

      return;
    }

    if (mode === "misconfigured") {
      // The variables themselves do not parse, which the storage platform answers
      // as `misconfigured` without contacting anything.
      delete process.env.STORAGE_BUCKET;
      resetStorageConfiguration();

      return;
    }

    getStorageProvider.mockReturnValue({
      checkBucket: vi.fn().mockRejectedValue(new Error("socket hang up")),
    });
  }

  it.each([
    { database: true, redis: "disabled", storage: "disabled", status: 200 },
    { database: false, redis: "disabled", storage: "disabled", status: 503 },
    { database: true, redis: "healthy", storage: "disabled", status: 200 },
    { database: true, redis: "unavailable", storage: "disabled", status: 503 },
    { database: true, redis: "disabled", storage: "healthy", status: 200 },
    { database: true, redis: "disabled", storage: "unavailable", status: 503 },
    {
      database: true,
      redis: "disabled",
      storage: "misconfigured",
      status: 503,
    },
    { database: true, redis: "healthy", storage: "healthy", status: 200 },
    {
      database: false,
      redis: "unavailable",
      storage: "unavailable",
      status: 503,
    },
  ] as const)(
    "answers $status for database=$database redis=$redis storage=$storage",
    async ({ database, redis, storage, status }) => {
      applyDatabase(database);
      applyRedis(redis);
      applyStorage(storage);

      const results = await runHealthChecks(createWebReadinessRegistry());
      const report = toReadinessReport(results);

      expect(httpStatusForReadiness(report)).toBe(status);
      expect(report.status).toBe(
        status === 200 ? READINESS_STATUS.READY : READINESS_STATUS.NOT_READY,
      );

      // Every dependency is accounted for in every combination, and every report
      // carries a status plus at most a published code.
      expect(Object.keys(report.checks).sort()).toEqual([
        "database",
        "redis",
        "storage",
      ]);

      for (const [name, check] of Object.entries(report.checks)) {
        const keys = Object.keys(check ?? {}).sort();

        expect(
          keys.length === 1 ? ["status"] : ["code", "status"],
          name,
        ).toEqual(keys);

        if (keys.includes("code")) {
          expect(HEALTH_CODES, name).toContain(
            (check as { code: string }).code,
          );
        }
      }

      // Nothing about the infrastructure reaches the document, in any combination.
      const serialized = JSON.stringify(report);

      for (const forbidden of [
        "hunter2",
        "cache.internal",
        "customer-documents",
        "objects.internal",
        "AKIAIOSFODNN7EXAMPLE",
        "db.internal",
        "latencyMs",
        "message",
        "stack",
        "queue",
      ]) {
        expect(serialized, forbidden).not.toContain(forbidden);
      }
    },
  );
});

describe("end to end, through the real platform contracts", () => {
  it("is ready on the default deployment: PostgreSQL only", async () => {
    const report = toReadinessReport(
      await runHealthChecks(createWebReadinessRegistry()),
    );

    expect(report.status).toBe(READINESS_STATUS.READY);
    expect(report.checks).toEqual({
      database: { status: DEPENDENCY_STATUS.HEALTHY },
      redis: { status: DEPENDENCY_STATUS.DISABLED },
      storage: { status: DEPENDENCY_STATUS.DISABLED },
    });

    // The whole claim of optionality: no client is built for a dependency that is
    // switched off, so no socket is opened and no name is resolved.
    expect(createClient).not.toHaveBeenCalled();
    expect(getStorageProvider).not.toHaveBeenCalled();
  });

  it("is not ready when PostgreSQL will not answer", async () => {
    queryRaw.mockRejectedValue(
      new Error("Can't reach database server at db.internal:5432"),
    );

    const report = toReadinessReport(
      await runHealthChecks(createWebReadinessRegistry()),
    );

    expect(report.status).toBe(READINESS_STATUS.NOT_READY);
    expect(report.checks.database).toEqual({
      status: DEPENDENCY_STATUS.UNHEALTHY,
      code: HEALTH_CODE.DATABASE_UNAVAILABLE,
    });
    expect(JSON.stringify(report)).not.toContain("db.internal");
  });

  it("is ready when an enabled Redis answers", async () => {
    enableRedis();

    const report = toReadinessReport(
      await runHealthChecks(createWebReadinessRegistry()),
    );

    expect(report.status).toBe(READINESS_STATUS.READY);
    expect(report.checks.redis).toEqual({
      status: DEPENDENCY_STATUS.HEALTHY,
    });
  });

  it("is not ready when an enabled Redis will not answer, and leaks no address", async () => {
    enableRedis();
    createClient.mockReturnValue({
      ...healthyRedisClient(),
      connect: vi
        .fn()
        .mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:6379")),
    });

    const report = toReadinessReport(
      await runHealthChecks(createWebReadinessRegistry()),
    );
    const serialized = JSON.stringify(report);

    expect(report.status).toBe(READINESS_STATUS.NOT_READY);
    expect(report.checks.redis).toEqual({
      status: DEPENDENCY_STATUS.UNHEALTHY,
      code: HEALTH_CODE.REDIS_UNAVAILABLE,
    });

    for (const forbidden of [
      "hunter2",
      "cache.internal",
      "redis://",
      "ECONNREFUSED",
      "10.1.2.3",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("is ready when an enabled object store answers", async () => {
    enableStorage();

    const report = toReadinessReport(
      await runHealthChecks(createWebReadinessRegistry()),
    );

    expect(report.status).toBe(READINESS_STATUS.READY);
    expect(report.checks.storage).toEqual({
      status: DEPENDENCY_STATUS.HEALTHY,
    });
  });

  it("names no bucket, endpoint, or credential when an enabled store fails", async () => {
    enableStorage();
    getStorageProvider.mockReturnValue({
      checkBucket: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "NoSuchBucket: customer-documents at https://objects.internal",
          ),
        ),
    });

    const report = toReadinessReport(
      await runHealthChecks(createWebReadinessRegistry()),
    );
    const serialized = JSON.stringify(report);

    expect(report.status).toBe(READINESS_STATUS.NOT_READY);

    for (const forbidden of [
      "customer-documents",
      "objects.internal",
      "AKIAIOSFODNN7EXAMPLE",
      "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
      "eu-west-1",
      "NoSuchBucket",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("is not ready when an enabled object store cannot be reached", async () => {
    enableStorage();
    getStorageProvider.mockReturnValue({
      checkBucket: vi.fn().mockRejectedValue(new Error("socket hang up")),
    });

    const report = toReadinessReport(
      await runHealthChecks(createWebReadinessRegistry()),
    );

    expect(report.checks.storage).toEqual({
      status: DEPENDENCY_STATUS.UNHEALTHY,
      code: HEALTH_CODE.STORAGE_UNAVAILABLE,
    });
  });

  it("reports several simultaneous failures, each with its own code", async () => {
    enableRedis();
    enableStorage();

    queryRaw.mockRejectedValue(new Error("no"));
    createClient.mockReturnValue({
      ...healthyRedisClient(),
      connect: vi.fn().mockRejectedValue(new Error("no")),
    });
    getStorageProvider.mockReturnValue({
      checkBucket: vi.fn().mockRejectedValue(new Error("no")),
    });

    const report = toReadinessReport(
      await runHealthChecks(createWebReadinessRegistry()),
    );

    expect(report.status).toBe(READINESS_STATUS.NOT_READY);
    expect(report.checks).toEqual({
      database: {
        status: DEPENDENCY_STATUS.UNHEALTHY,
        code: HEALTH_CODE.DATABASE_UNAVAILABLE,
      },
      redis: {
        status: DEPENDENCY_STATUS.UNHEALTHY,
        code: HEALTH_CODE.REDIS_UNAVAILABLE,
      },
      storage: {
        status: DEPENDENCY_STATUS.UNHEALTHY,
        code: HEALTH_CODE.STORAGE_UNAVAILABLE,
      },
    });
  });

  it("stays ready when only the optional dependencies are off and PostgreSQL is up", async () => {
    const report = toReadinessReport(
      await runHealthChecks(createWebReadinessRegistry()),
    );

    expect(report.status).toBe(READINESS_STATUS.READY);
  });
});
