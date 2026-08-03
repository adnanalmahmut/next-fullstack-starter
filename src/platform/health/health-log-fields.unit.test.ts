import { describe, expect, it } from "vitest";

const { HEALTH_LOG_FIELD_NAMES, toHealthLogFields } =
  await import("./health-log-fields");
const { HEALTH_LOG_EVENT, HEALTH_LOG_EVENTS } = await import("./log-event");
const { HEALTH_CODE } = await import("./health-code");
const { DEPENDENCY_STATUS, HEALTH_PROCESS, READINESS_STATUS } =
  await import("./health-status");

/**
 * The log-field allowlist, and the event names.
 *
 * A health line is written at the exact moment somebody wants to know why, so it
 * is the most tempting place in the system to print the address that refused or
 * the exception that came back. The closure is applied by `toHealthLogFields`
 * rather than by each call site, and these tests are what make that a guarantee.
 */
describe("the allowlist", () => {
  it("permits exactly the documented fields", () => {
    expect([...HEALTH_LOG_FIELD_NAMES]).toEqual([
      "process",
      "status",
      "code",
      "databaseStatus",
      "redisStatus",
      "storageStatus",
      "queueStatus",
      "durationMs",
    ]);
  });

  it("keeps every permitted field", () => {
    const input = {
      process: HEALTH_PROCESS.WEB,
      status: READINESS_STATUS.NOT_READY,
      code: HEALTH_CODE.NOT_READY,
      databaseStatus: DEPENDENCY_STATUS.UNHEALTHY,
      redisStatus: DEPENDENCY_STATUS.DISABLED,
      storageStatus: DEPENDENCY_STATUS.HEALTHY,
      queueStatus: DEPENDENCY_STATUS.DISABLED,
      durationMs: 12,
    } as const;

    expect(toHealthLogFields(input)).toEqual(input);
  });

  it("omits an absent field rather than writing null", () => {
    // A line must not claim to know the state of a dependency it never checked,
    // which is exactly the case for a misconfigured worker.
    const fields = toHealthLogFields({
      process: HEALTH_PROCESS.WORKER,
      status: READINESS_STATUS.NOT_READY,
    });

    expect(Object.keys(fields).sort()).toEqual(["process", "status"]);
    expect(fields).not.toHaveProperty("databaseStatus");
  });

  it("treats an explicit undefined as absent", () => {
    expect(
      toHealthLogFields({
        process: HEALTH_PROCESS.WEB,
        durationMs: undefined,
      }),
    ).toEqual({ process: HEALTH_PROCESS.WEB });
  });

  it("returns an empty payload for an empty input", () => {
    expect(toHealthLogFields({})).toEqual({});
  });

  it.each([
    {
      name: "a database URL",
      field: "databaseUrl",
      value: "postgresql://app:hunter2@db.internal:5432/app",
    },
    {
      name: "a Redis URL",
      field: "redisUrl",
      value: "redis://cache.internal:6379",
    },
    {
      name: "a queue Redis URL",
      field: "jobsRedisUrl",
      value: "redis://queue.internal:6379",
    },
    { name: "a queue prefix", field: "queuePrefix", value: "jobs:production" },
    { name: "a bucket", field: "bucket", value: "customer-documents" },
    {
      name: "an endpoint",
      field: "endpoint",
      value: "https://s3.eu-west-1.amazonaws.com",
    },
    { name: "a host", field: "host", value: "db.internal" },
    {
      name: "a credential",
      field: "secretAccessKey",
      value: "AKIAIOSFODNN7EXAMPLE",
    },
    {
      name: "an exception message",
      field: "message",
      value: "connect ECONNREFUSED",
    },
    { name: "a stack trace", field: "stack", value: "Error: no\n    at main" },
    { name: "a payload", field: "payload", value: { userId: "user-1" } },
    { name: "a job name", field: "jobName", value: "email.send" },
  ])("drops $name", ({ field, value }) => {
    const fields = toHealthLogFields({
      process: HEALTH_PROCESS.WORKER,
      [field]: value,
    } as never);

    expect(fields).not.toHaveProperty(field);
    expect(JSON.stringify(fields)).not.toContain(
      typeof value === "string" ? value : "user-1",
    );
  });

  it("drops everything outside the allowlist, not a hand-picked list of bad names", () => {
    const fields = toHealthLogFields({
      process: HEALTH_PROCESS.WEB,
      anythingAtAll: "kept?",
      nested: { deep: "kept?" },
    } as never);

    expect(Object.keys(fields)).toEqual(["process"]);
  });
});

describe("the events", () => {
  it("publishes exactly two events", () => {
    expect([...HEALTH_LOG_EVENTS].sort()).toEqual([
      "health.readiness.failed",
      "health.worker.checked",
    ]);
  });

  it("has no event for a successful readiness probe", () => {
    // A load balancer calls that endpoint every few seconds for the lifetime of a
    // deployment; a line per success would bury the ones that matter.
    expect(HEALTH_LOG_EVENTS).not.toContain("health.readiness.succeeded");
    expect(Object.keys(HEALTH_LOG_EVENT)).not.toContain("READINESS_SUCCEEDED");
  });

  it("uses dotted, lowercase, language-neutral identifiers", () => {
    for (const event of HEALTH_LOG_EVENTS) {
      expect(event).toMatch(/^health(?:\.[a-z][a-z0-9_]*)+$/);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(HEALTH_LOG_EVENTS)).toBe(true);
  });
});
