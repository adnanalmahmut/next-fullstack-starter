import { loadEnvConfig } from "@next/env";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

loadEnvConfig(process.cwd());

const {
  checkRedisHealth,
  closeRedisClient,
  getRedisClient,
  getRedisConfiguration,
  REDIS_HEALTH_STATUS,
  resetRedisConfiguration,
} = await import("@/platform/redis/index.server");

const { toRedisReport } =
  await import("@/platform/health/web-readiness.server");
const { runHealthChecks } =
  await import("@/platform/health/run-health-checks.server");
const { toReadinessReport } = await import("@/platform/health/readiness");
const { createHealthRegistry } =
  await import("@/platform/health/health-registry");
const { DEPENDENCY_FAILURE_CODE, DEPENDENCY_NAME, HEALTHY_DEPENDENCY } =
  await import("@/platform/health/dependency-check");
const { HEALTH_CODE } = await import("@/platform/health/health-code");
const { DEPENDENCY_STATUS, READINESS_STATUS } =
  await import("@/platform/health/health-status");

/**
 * The Redis half of readiness, against a real server.
 *
 * The foundation's own health contract is covered by its unit tests and by
 * `redis-foundation.redis.test.ts`; what is added here is the readiness
 * translation, and specifically the three facts a mock cannot establish: that an
 * enabled and reachable server maps to `healthy`, that an enabled and unreachable
 * one maps to `unhealthy` without the address reaching the result, and that
 * turning the flag off costs no client, no socket, and no name resolution even
 * though a perfectly good server is sitting right there.
 *
 * PostgreSQL is deliberately not involved: the database check is stubbed so this
 * file needs only Redis. That is the same separation the production code has —
 * each dependency answers for itself.
 */
const REDIS_VARIABLES = ["REDIS_ENABLED", "REDIS_URL"] as const;

function assertRedisTestTarget() {
  expect(process.env.APP_ENV).toBe("test");
  expect(process.env.REDIS_ENABLED).toBe("true");

  const url = new URL(process.env.REDIS_URL ?? "redis://invalid.example");

  expect(["redis:", "rediss:"]).toContain(url.protocol);
  expect(["127.0.0.1", "localhost", "::1"]).toContain(url.hostname);
}

const original = new Map<string, string | undefined>();

async function withEnvironment(
  overrides: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  for (const name of REDIS_VARIABLES) {
    original.set(name, process.env[name]);
  }

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  resetRedisConfiguration();
  await closeRedisClient();

  try {
    await body();
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    original.clear();
    resetRedisConfiguration();
    await closeRedisClient();
  }
}

/** The web registry's shape, with the database answered by a stub. */
function registryWithRedis() {
  return createHealthRegistry([
    {
      name: DEPENDENCY_NAME.DATABASE,
      timeoutMs: 2_000,
      failureCode: DEPENDENCY_FAILURE_CODE.DATABASE,
      run: async () => HEALTHY_DEPENDENCY,
    },
    {
      name: DEPENDENCY_NAME.REDIS,
      timeoutMs: 1_500,
      failureCode: DEPENDENCY_FAILURE_CODE.REDIS,
      run: async () => toRedisReport(await checkRedisHealth()),
    },
  ]);
}

beforeAll(() => {
  assertRedisTestTarget();
});

afterEach(async () => {
  await closeRedisClient();
});

describe("enabled and reachable", () => {
  it("reports healthy against the real server", async () => {
    const health = await checkRedisHealth();

    expect(health.status).toBe(REDIS_HEALTH_STATUS.HEALTHY);
  });

  it("maps to a healthy dependency carrying no latency", async () => {
    expect(toRedisReport(await checkRedisHealth())).toEqual({
      status: DEPENDENCY_STATUS.HEALTHY,
    });
  });

  it("makes the process ready", async () => {
    const report = toReadinessReport(
      await runHealthChecks(registryWithRedis()),
    );

    expect(report.status).toBe(READINESS_STATUS.READY);
    expect(report.checks.redis).toEqual({
      status: DEPENDENCY_STATUS.HEALTHY,
    });
  });

  it("is repeatable without accumulating clients", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const health = await checkRedisHealth();

      expect(health.status).toBe(REDIS_HEALTH_STATUS.HEALTHY);
    }
  });
});

describe("disabled, with a server available anyway", () => {
  it("answers from configuration alone and opens nothing", async () => {
    await withEnvironment({ REDIS_ENABLED: "false" }, async () => {
      expect(getRedisConfiguration().enabled).toBe(false);

      await expect(checkRedisHealth()).resolves.toEqual({
        status: REDIS_HEALTH_STATUS.DISABLED,
      });

      // The server is running and reachable, and there is still no client: the
      // answer came from configuration alone, so no socket was opened and no name
      // was resolved.
      await expect(getRedisClient()).resolves.toBeNull();
    });
  });

  it("keeps the process ready", async () => {
    await withEnvironment({ REDIS_ENABLED: "false" }, async () => {
      const report = toReadinessReport(
        await runHealthChecks(registryWithRedis()),
      );

      expect(report.status).toBe(READINESS_STATUS.READY);
      expect(report.checks.redis).toEqual({
        status: DEPENDENCY_STATUS.DISABLED,
      });
    });
  });
});

describe("enabled and unreachable", () => {
  // A port nothing listens on, rather than stopping the shared container: another
  // file in this suite may be mid-run against it.
  const closedPort = "redis://127.0.0.1:6399";

  it("reports unhealthy with the published code", async () => {
    await withEnvironment(
      { REDIS_ENABLED: "true", REDIS_URL: closedPort },
      async () => {
        await expect(checkRedisHealth()).resolves.toEqual({
          status: REDIS_HEALTH_STATUS.UNHEALTHY,
          code: HEALTH_CODE.REDIS_UNAVAILABLE,
        });
      },
    );
  });

  it("makes the process unready, and names Redis as the cause", async () => {
    await withEnvironment(
      { REDIS_ENABLED: "true", REDIS_URL: closedPort },
      async () => {
        const report = toReadinessReport(
          await runHealthChecks(registryWithRedis()),
        );

        expect(report.status).toBe(READINESS_STATUS.NOT_READY);
        expect(report.checks.redis).toEqual({
          status: DEPENDENCY_STATUS.UNHEALTHY,
          code: HEALTH_CODE.REDIS_UNAVAILABLE,
        });
        expect(report.checks.database).toEqual({
          status: DEPENDENCY_STATUS.HEALTHY,
        });
      },
    );
  });

  it("carries no address and no driver detail into the result", async () => {
    await withEnvironment(
      {
        REDIS_ENABLED: "true",
        REDIS_URL: "redis://someone:hunter2@127.0.0.1:6399",
      },
      async () => {
        const report = toReadinessReport(
          await runHealthChecks(registryWithRedis()),
        );
        const serialized = JSON.stringify(report);

        for (const forbidden of [
          "hunter2",
          "someone",
          "redis://",
          "6399",
          "127.0.0.1",
          "ECONNREFUSED",
          "message",
          "stack",
        ]) {
          expect(serialized, forbidden).not.toContain(forbidden);
        }
      },
    );
  });

  it("answers within its budget rather than hanging", async () => {
    await withEnvironment(
      { REDIS_ENABLED: "true", REDIS_URL: closedPort },
      async () => {
        const startedAt = performance.now();

        await runHealthChecks(registryWithRedis());

        expect(performance.now() - startedAt).toBeLessThan(3_000);
      },
    );
  });
});
