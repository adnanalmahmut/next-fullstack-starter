import { beforeEach, describe, expect, it, vi } from "vitest";

const info = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
const error = vi.hoisted(() => vi.fn());

vi.mock("@/platform/observability/logger.server", () => {
  const silentLogger = {
    trace: () => undefined,
    debug: () => undefined,
    info,
    warn,
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

const { HEALTH_LOG_LEVEL, logHealthEvent } =
  await import("./health-logger.server");
const { HEALTH_LOG_EVENT } = await import("./log-event");
const { HEALTH_CODE } = await import("./health-code");
const { DEPENDENCY_STATUS, HEALTH_PROCESS, READINESS_STATUS } =
  await import("./health-status");

/**
 * The single writer.
 *
 * The point of routing every line through one function is that the allowlist is
 * applied by construction. These tests prove it is applied here rather than being
 * something each call site remembers.
 */
beforeEach(() => {
  vi.clearAllMocks();
});

describe("levels", () => {
  it("offers exactly the three levels a health line needs", () => {
    expect(Object.values(HEALTH_LOG_LEVEL).sort()).toEqual([
      "error",
      "info",
      "warn",
    ]);
  });

  it.each([
    { level: "info" as const, spy: info },
    { level: "warn" as const, spy: warn },
    { level: "error" as const, spy: error },
  ])("writes at $level", ({ level, spy }) => {
    logHealthEvent(level, HEALTH_LOG_EVENT.READINESS_FAILED, {
      process: HEALTH_PROCESS.WEB,
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("payload", () => {
  it("writes the event name as the message and the fields as the payload", () => {
    logHealthEvent(HEALTH_LOG_LEVEL.WARN, HEALTH_LOG_EVENT.READINESS_FAILED, {
      process: HEALTH_PROCESS.WEB,
      status: READINESS_STATUS.NOT_READY,
      code: HEALTH_CODE.NOT_READY,
      databaseStatus: DEPENDENCY_STATUS.UNHEALTHY,
      durationMs: 7,
    });

    expect(warn).toHaveBeenCalledWith(
      {
        process: "web",
        status: "not_ready",
        code: "NOT_READY",
        databaseStatus: "unhealthy",
        durationMs: 7,
      },
      "health.readiness.failed",
    );
  });

  it("applies the allowlist rather than trusting the caller", () => {
    logHealthEvent(
      HEALTH_LOG_LEVEL.ERROR,
      HEALTH_LOG_EVENT.WORKER_READINESS_CHECKED,
      {
        process: HEALTH_PROCESS.WORKER,
        jobsRedisUrl: "redis://queue.internal:6379",
        queuePrefix: "jobs:production",
      } as never,
    );

    const [payload] = error.mock.calls[0] ?? [];

    expect(payload).toEqual({ process: "worker" });
    expect(JSON.stringify(payload)).not.toContain("redis://");
    expect(JSON.stringify(payload)).not.toContain("queue.internal");
  });

  it("writes an empty payload when given no fields", () => {
    logHealthEvent(
      HEALTH_LOG_LEVEL.INFO,
      HEALTH_LOG_EVENT.WORKER_READINESS_CHECKED,
    );

    expect(info).toHaveBeenCalledWith({}, "health.worker.checked");
  });
});
