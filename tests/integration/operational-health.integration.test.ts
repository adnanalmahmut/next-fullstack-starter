import { loadEnvConfig } from "@next/env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

loadEnvConfig(process.cwd());

vi.doMock("server-only", () => ({}));

const {
  checkDatabaseHealth,
  DATABASE_HEALTH_STATUS,
  DATABASE_UNAVAILABLE,
  database,
} = await import("@/platform/database/index.server");

const { createWebReadinessRegistry, toDatabaseReport } =
  await import("@/platform/health/web-readiness.server");
const { runHealthChecks } =
  await import("@/platform/health/run-health-checks.server");
const { toReadinessReport } = await import("@/platform/health/readiness");
const { DEPENDENCY_STATUS, READINESS_STATUS } =
  await import("@/platform/health/health-status");
const { HEALTH_CODE } = await import("@/platform/health/health-code");

/**
 * The health contracts against a real PostgreSQL.
 *
 * What is being proved here cannot be proved with a mock: that the statement the
 * probe sends is one this PostgreSQL accepts, that it is genuinely read-only
 * according to PostgreSQL rather than according to this repository's opinion of
 * it, and that a web process with Redis and object storage switched off reports
 * itself ready with the database as its only dependency.
 *
 * The failure mapping is proved through an injected probe rather than by stopping
 * a container. The development and test databases are shared with every other
 * suite and with the developer running this, and a test that stopped one would
 * fail everything else running beside it — including, on a small machine, in ways
 * that look like an unrelated flake.
 */
const REDIS_ENABLED = process.env.REDIS_ENABLED;
const STORAGE_ENABLED = process.env.STORAGE_ENABLED;

beforeAll(() => {
  // This suite asserts the default deployment shape, so both optional
  // dependencies are explicitly off rather than inherited from a shell.
  delete process.env.REDIS_ENABLED;
  delete process.env.STORAGE_ENABLED;
});

afterAll(async () => {
  if (REDIS_ENABLED === undefined) {
    delete process.env.REDIS_ENABLED;
  } else {
    process.env.REDIS_ENABLED = REDIS_ENABLED;
  }

  if (STORAGE_ENABLED === undefined) {
    delete process.env.STORAGE_ENABLED;
  } else {
    process.env.STORAGE_ENABLED = STORAGE_ENABLED;
  }

  await database.$disconnect();
});

async function tableCounts(): Promise<Record<string, number>> {
  const [users, sessions, outbox, receipts, audit, objects, intents] =
    await Promise.all([
      database.user.count(),
      database.session.count(),
      database.outboxMessage.count(),
      database.jobExecutionReceipt.count(),
      database.auditRecord.count(),
      database.storageObject.count(),
      database.storageUploadIntent.count(),
    ]);

  return { users, sessions, outbox, receipts, audit, objects, intents };
}

describe("the database check", () => {
  it("reports healthy against a real PostgreSQL", async () => {
    const health = await checkDatabaseHealth();

    expect(health.status).toBe(DATABASE_HEALTH_STATUS.HEALTHY);

    if (health.status === DATABASE_HEALTH_STATUS.HEALTHY) {
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(health.latencyMs).toBeLessThan(2_000);
    }
  });

  it("carries a latency and nothing that describes the server", async () => {
    const serialized = JSON.stringify(await checkDatabaseHealth());
    const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid");

    expect(Object.keys(JSON.parse(serialized) as object).sort()).toEqual([
      "latencyMs",
      "status",
    ]);

    for (const forbidden of [
      url.hostname,
      url.port,
      url.username,
      url.password,
      "postgresql://",
      "schema",
      "public",
    ].filter((value) => value.length > 0)) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("succeeds inside a read-only transaction, so PostgreSQL itself vouches for it", async () => {
    // The strongest available proof that the probe writes nothing: the server is
    // told to refuse any write for the duration, and the check still passes.
    await database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET TRANSACTION READ ONLY`;

      const health = await checkDatabaseHealth({
        $queryRaw: (query, ...values) =>
          transaction.$queryRaw(query, ...values) as Promise<unknown>,
      });

      expect(health.status).toBe(DATABASE_HEALTH_STATUS.HEALTHY);
    });
  });

  it("changes no row in any table", async () => {
    const before = await tableCounts();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await checkDatabaseHealth();
    }

    expect(await tableCounts()).toEqual(before);
  });

  it("leaves the shared client usable afterwards", async () => {
    await checkDatabaseHealth();

    await expect(
      database.$queryRaw<Array<{ value: number }>>`SELECT 1::integer AS value`,
    ).resolves.toEqual([{ value: 1 }]);
  });

  it("maps a failing connection to a stable code, through an injected probe", async () => {
    // Injected rather than achieved by stopping the container: the development and
    // test databases are shared, and a suite that stopped one would break every
    // other suite running beside it.
    const health = await checkDatabaseHealth({
      $queryRaw: () =>
        Promise.reject(
          new Error(
            "Can't reach database server at 127.0.0.1:5433 (postgresql://app:hunter2@127.0.0.1:5433/db)",
          ),
        ),
    });

    expect(health).toEqual({
      status: DATABASE_HEALTH_STATUS.UNHEALTHY,
      code: DATABASE_UNAVAILABLE,
    });
    expect(JSON.stringify(health)).not.toContain("hunter2");
  });

  it("maps a hanging connection to the same code, and answers", async () => {
    const startedAt = performance.now();

    const health = await checkDatabaseHealth({
      $queryRaw: () => new Promise(() => undefined),
    });

    expect(health).toEqual({
      status: DATABASE_HEALTH_STATUS.UNHEALTHY,
      code: DATABASE_UNAVAILABLE,
    });
    expect(performance.now() - startedAt).toBeLessThan(4_000);
  });
});

describe("web readiness on the default deployment", () => {
  it("is ready with PostgreSQL alone", async () => {
    const report = toReadinessReport(
      await runHealthChecks(createWebReadinessRegistry()),
    );

    expect(report).toEqual({
      status: READINESS_STATUS.READY,
      code: HEALTH_CODE.READY,
      checks: {
        database: { status: DEPENDENCY_STATUS.HEALTHY },
        redis: { status: DEPENDENCY_STATUS.DISABLED },
        storage: { status: DEPENDENCY_STATUS.DISABLED },
      },
    });
  });

  it("never reports on the queue, the worker, or the outbox", async () => {
    const report = toReadinessReport(
      await runHealthChecks(createWebReadinessRegistry()),
    );

    expect(Object.keys(report.checks).sort()).toEqual([
      "database",
      "redis",
      "storage",
    ]);
    expect(JSON.stringify(report)).not.toContain("queue");
    expect(JSON.stringify(report)).not.toContain("outbox");
  });

  it("is repeatable, and leaves the database usable", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const report = toReadinessReport(
        await runHealthChecks(createWebReadinessRegistry()),
      );

      expect(report.status).toBe(READINESS_STATUS.READY);
    }

    await expect(database.user.count()).resolves.toBeGreaterThanOrEqual(0);
  });

  it("stays ready when the database mapping is applied to a real result", async () => {
    expect(toDatabaseReport(await checkDatabaseHealth())).toEqual({
      status: DEPENDENCY_STATUS.HEALTHY,
    });
  });
});
