import { describe, expect, it } from "vitest";

import type { DependencyCheckResult } from "./dependency-check";

const {
  httpStatusForReadiness,
  READINESS_HTTP_STATUS,
  toReadinessReport,
  UNKNOWN_READINESS_REPORT,
} = await import("./readiness");
const {
  DEPENDENCY_NAME,
  DISABLED_DEPENDENCY,
  HEALTHY_DEPENDENCY,
  unhealthyDependency,
} = await import("./dependency-check");
const { HEALTH_CODE } = await import("./health-code");
const { DEPENDENCY_STATUS, READINESS_STATUS } = await import("./health-status");

/**
 * The aggregation.
 *
 * One rule decides everything: a dependency is a failure only when it is
 * `unhealthy`. Everything else here follows from that — a disabled Redis and a
 * disabled object store keep a process ready, a single unhealthy dependency makes
 * it unready no matter how many others are fine, and the status maps onto exactly
 * two HTTP codes.
 */
function result(
  name: DependencyCheckResult["name"],
  report: DependencyCheckResult["report"],
): DependencyCheckResult {
  return { name, report, durationMs: 1 };
}

describe("ready", () => {
  it("is ready when every dependency is healthy", () => {
    const report = toReadinessReport([
      result(DEPENDENCY_NAME.DATABASE, HEALTHY_DEPENDENCY),
      result(DEPENDENCY_NAME.REDIS, HEALTHY_DEPENDENCY),
      result(DEPENDENCY_NAME.STORAGE, HEALTHY_DEPENDENCY),
    ]);

    expect(report.status).toBe(READINESS_STATUS.READY);
    expect(report.code).toBe(HEALTH_CODE.READY);
  });

  it("is ready when the optional dependencies are switched off", () => {
    // The default deployment of this starter: PostgreSQL only.
    const report = toReadinessReport([
      result(DEPENDENCY_NAME.DATABASE, HEALTHY_DEPENDENCY),
      result(DEPENDENCY_NAME.REDIS, DISABLED_DEPENDENCY),
      result(DEPENDENCY_NAME.STORAGE, DISABLED_DEPENDENCY),
    ]);

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
});

describe("not ready", () => {
  it.each([
    {
      name: "the database",
      dependency: DEPENDENCY_NAME.DATABASE,
      code: HEALTH_CODE.DATABASE_UNAVAILABLE,
    },
    {
      name: "Redis",
      dependency: DEPENDENCY_NAME.REDIS,
      code: HEALTH_CODE.REDIS_UNAVAILABLE,
    },
    {
      name: "object storage",
      dependency: DEPENDENCY_NAME.STORAGE,
      code: HEALTH_CODE.STORAGE_UNAVAILABLE,
    },
    {
      name: "a misconfigured object store",
      dependency: DEPENDENCY_NAME.STORAGE,
      code: HEALTH_CODE.STORAGE_MISCONFIGURED,
    },
  ])("is not ready when $name is unhealthy", ({ dependency, code }) => {
    const report = toReadinessReport([
      result(DEPENDENCY_NAME.DATABASE, HEALTHY_DEPENDENCY),
      result(DEPENDENCY_NAME.REDIS, HEALTHY_DEPENDENCY),
      result(DEPENDENCY_NAME.STORAGE, HEALTHY_DEPENDENCY),
      result(dependency, unhealthyDependency(code)),
    ]);

    expect(report.status).toBe(READINESS_STATUS.NOT_READY);
    expect(report.code).toBe(HEALTH_CODE.NOT_READY);
    expect(report.checks[dependency]).toEqual({
      status: DEPENDENCY_STATUS.UNHEALTHY,
      code,
    });
  });

  it("reports every failure rather than only the first", () => {
    const report = toReadinessReport([
      result(
        DEPENDENCY_NAME.DATABASE,
        unhealthyDependency(HEALTH_CODE.DATABASE_UNAVAILABLE),
      ),
      result(
        DEPENDENCY_NAME.REDIS,
        unhealthyDependency(HEALTH_CODE.REDIS_UNAVAILABLE),
      ),
      result(
        DEPENDENCY_NAME.STORAGE,
        unhealthyDependency(HEALTH_CODE.STORAGE_MISCONFIGURED),
      ),
    ]);

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
        code: HEALTH_CODE.STORAGE_MISCONFIGURED,
      },
    });
  });

  it("keeps a disabled dependency from turning an unready answer's cause into a guess", () => {
    const report = toReadinessReport([
      result(
        DEPENDENCY_NAME.DATABASE,
        unhealthyDependency(HEALTH_CODE.DATABASE_UNAVAILABLE),
      ),
      result(DEPENDENCY_NAME.REDIS, DISABLED_DEPENDENCY),
    ]);

    expect(report.checks.redis).toEqual({
      status: DEPENDENCY_STATUS.DISABLED,
    });
    expect(report.checks.redis).not.toHaveProperty("code");
  });
});

describe("the document", () => {
  it("lists every dependency in registry order", () => {
    const report = toReadinessReport([
      result(DEPENDENCY_NAME.STORAGE, DISABLED_DEPENDENCY),
      result(DEPENDENCY_NAME.DATABASE, HEALTHY_DEPENDENCY),
      result(DEPENDENCY_NAME.REDIS, DISABLED_DEPENDENCY),
    ]);

    expect(Object.keys(report.checks)).toEqual([
      "storage",
      "database",
      "redis",
    ]);
  });

  it("omits no dependency that was checked", () => {
    const report = toReadinessReport([
      result(DEPENDENCY_NAME.DATABASE, HEALTHY_DEPENDENCY),
      result(DEPENDENCY_NAME.REDIS, DISABLED_DEPENDENCY),
      result(DEPENDENCY_NAME.STORAGE, DISABLED_DEPENDENCY),
    ]);

    expect(Object.keys(report.checks)).toHaveLength(3);
  });

  it("carries exactly three top-level fields", () => {
    const report = toReadinessReport([
      result(DEPENDENCY_NAME.DATABASE, HEALTHY_DEPENDENCY),
    ]);

    expect(Object.keys(report).sort()).toEqual(["checks", "code", "status"]);
  });

  it.each([
    "timestamp",
    "latencyMs",
    "durationMs",
    "message",
    "detail",
    "reason",
    "hostname",
    "version",
    "url",
    "endpoint",
    "bucket",
    "queue",
  ])("has no %s field", (field) => {
    const report = toReadinessReport([
      result(
        DEPENDENCY_NAME.DATABASE,
        unhealthyDependency(HEALTH_CODE.DATABASE_UNAVAILABLE),
      ),
    ]);

    expect(report).not.toHaveProperty(field);
    expect(report.checks.database).not.toHaveProperty(field);
  });
});

describe("HTTP status", () => {
  it("answers 200 when ready", () => {
    const report = toReadinessReport([
      result(DEPENDENCY_NAME.DATABASE, HEALTHY_DEPENDENCY),
    ]);

    expect(httpStatusForReadiness(report)).toBe(200);
    expect(READINESS_HTTP_STATUS.READY).toBe(200);
  });

  it("answers 503 when not ready", () => {
    const report = toReadinessReport([
      result(
        DEPENDENCY_NAME.DATABASE,
        unhealthyDependency(HEALTH_CODE.DATABASE_UNAVAILABLE),
      ),
    ]);

    expect(httpStatusForReadiness(report)).toBe(503);
    expect(READINESS_HTTP_STATUS.NOT_READY).toBe(503);
  });

  it("answers only those two statuses", () => {
    // 503 rather than 500: the process is working and telling the truth about a
    // dependency, which is what a load balancer already knows how to read.
    expect(Object.values(READINESS_HTTP_STATUS).sort()).toEqual([200, 503]);
  });
});

describe("the fallback document", () => {
  it("is an ordinary not-ready answer", () => {
    expect(UNKNOWN_READINESS_REPORT).toEqual({
      status: READINESS_STATUS.NOT_READY,
      code: HEALTH_CODE.NOT_READY,
      checks: {},
    });
  });

  it("maps to 503", () => {
    expect(httpStatusForReadiness(UNKNOWN_READINESS_REPORT)).toBe(503);
  });

  it("is frozen, being a shared module-level value", () => {
    expect(Object.isFrozen(UNKNOWN_READINESS_REPORT)).toBe(true);
    expect(Object.isFrozen(UNKNOWN_READINESS_REPORT.checks)).toBe(true);
  });
});
