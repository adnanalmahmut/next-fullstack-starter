import type { DestinationStream } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ForbiddenError,
  InternalError,
} from "@/shared/errors/application-error";

import { createApplicationLogger } from "../create-logger.server";
import { TELEMETRY_PROCESS_TYPE } from "../telemetry/telemetry-status";

import { ERROR_BOUNDARY } from "./error-monitor";
import {
  captureUnexpectedError,
  errorMonitorStatus,
  flushErrorMonitor,
  resetErrorMonitor,
  shutdownErrorMonitor,
  startErrorMonitor,
} from "./error-monitor.server";
import {
  ERROR_MONITORING_STATUS,
  resetErrorMonitoringConfiguration,
} from "./error-monitoring-config";

const DSN = "https://public-key@127.0.0.1/42";

function createCapture() {
  const output: string[] = [];
  const destination: DestinationStream = {
    write(message) {
      output.push(message);
    },
  };

  return {
    logger: createApplicationLogger({
      environment: "test",
      level: "trace",
      destination,
    }),
    entries: () =>
      output.map((message) => JSON.parse(message) as Record<string, unknown>),
    raw: () => output.join(""),
  };
}

beforeEach(() => {
  resetErrorMonitor();
  resetErrorMonitoringConfiguration();
});

afterEach(async () => {
  await shutdownErrorMonitor();
  resetErrorMonitor();
  resetErrorMonitoringConfiguration();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the disabled default", () => {
  it("starts as a no-op and reports disabled", async () => {
    const handle = await startErrorMonitor({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });

    expect(handle).toEqual({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
      status: ERROR_MONITORING_STATUS.DISABLED,
    });
    expect(errorMonitorStatus()).toBe(ERROR_MONITORING_STATUS.DISABLED);
  });

  it("logs nothing when error monitoring was never asked for", async () => {
    const capture = createCapture();

    await startErrorMonitor({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
      logger: capture.logger,
    });

    expect(capture.entries()).toEqual([]);
  });

  it("captures, flushes, and shuts down without doing anything", async () => {
    await startErrorMonitor({ processType: TELEMETRY_PROCESS_TYPE.WORKER });

    expect(
      captureUnexpectedError(new InternalError("defect"), {
        boundary: ERROR_BOUNDARY.JOB,
      }),
    ).toBeUndefined();
    await expect(flushErrorMonitor(10)).resolves.toBeUndefined();
    await expect(shutdownErrorMonitor()).resolves.toBeUndefined();
  });

  it("shares one initialization promise across concurrent callers", () => {
    const first = startErrorMonitor({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });
    const second = startErrorMonitor({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });

    expect(first).toBe(second);

    return first;
  });
});

describe("an invalid configuration", () => {
  it("degrades to a no-op and logs one sanitized line", async () => {
    const capture = createCapture();

    vi.stubEnv("ERROR_MONITORING_ENABLED", "true");
    vi.stubEnv("SENTRY_DSN", "not-a-dsn-with-secret-key");
    resetErrorMonitoringConfiguration();

    const handle = await startErrorMonitor({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
      logger: capture.logger,
    });

    expect(handle.status).toBe(ERROR_MONITORING_STATUS.INVALID_CONFIGURATION);
    expect(capture.entries()[0]).toEqual(
      expect.objectContaining({
        msg: "error_monitoring.start_failed",
        status: ERROR_MONITORING_STATUS.INVALID_CONFIGURATION,
      }),
    );
    expect(capture.raw()).not.toContain("secret-key");
  });
});

describe("capture filtering", () => {
  it("drops an expected refusal before a monitor is consulted", async () => {
    const monitor = { capture: vi.fn(), flush: vi.fn(), shutdown: vi.fn() };

    // The state holds whichever monitor was installed, so replacing it is enough
    // to observe what reaches a provider — no vendor SDK required.
    const state = globalThis as typeof globalThis & {
      errorMonitorState?: { monitor: typeof monitor };
    };

    await startErrorMonitor({ processType: TELEMETRY_PROCESS_TYPE.WEB });

    if (state.errorMonitorState) {
      state.errorMonitorState.monitor = monitor;
    }

    // The filter is applied before the monitor is consulted, so the decision is
    // one place rather than five.
    captureUnexpectedError(new ForbiddenError("no"), {
      boundary: ERROR_BOUNDARY.ROUTE,
    });

    expect(monitor.capture).not.toHaveBeenCalled();

    captureUnexpectedError(new InternalError("defect"), {
      boundary: ERROR_BOUNDARY.ROUTE,
    });

    expect(monitor.capture).toHaveBeenCalledTimes(1);
  });

  it("contains a monitor whose capture throws", async () => {
    const state = globalThis as typeof globalThis & {
      errorMonitorState?: {
        monitor: {
          capture: () => void;
          flush: () => Promise<void>;
          shutdown: () => Promise<void>;
        };
      };
    };

    await startErrorMonitor({ processType: TELEMETRY_PROCESS_TYPE.WEB });

    if (state.errorMonitorState) {
      state.errorMonitorState.monitor = {
        capture: () => {
          throw new Error("the provider is broken");
        },
        flush: async () => {
          throw new Error("flush is broken");
        },
        shutdown: async () => {
          throw new Error("shutdown is broken");
        },
      };
    }

    // Reporting a failure must never become a second failure.
    expect(() =>
      captureUnexpectedError(new InternalError("defect"), {
        boundary: ERROR_BOUNDARY.ROUTE,
      }),
    ).not.toThrow();
    await expect(flushErrorMonitor(10)).resolves.toBeUndefined();
    await expect(shutdownErrorMonitor()).resolves.toBeUndefined();
  });

  it("never throws, whatever it is handed", () => {
    for (const error of [undefined, null, "string", 42, new Error("boom")]) {
      expect(() =>
        captureUnexpectedError(error, { boundary: ERROR_BOUNDARY.OUTBOX }),
      ).not.toThrow();
    }
  });
});

describe("an enabled configuration", () => {
  beforeEach(() => {
    vi.stubEnv("ERROR_MONITORING_ENABLED", "true");
    // A loopback host with no listener. Nothing here waits for a send, so an
    // unreachable ingest endpoint is exactly the right thing to start against.
    vi.stubEnv("SENTRY_DSN", DSN);
    resetErrorMonitoringConfiguration();
  });

  it("starts, reports started, and logs no DSN", async () => {
    const capture = createCapture();

    const handle = await startErrorMonitor({
      processType: TELEMETRY_PROCESS_TYPE.WORKER,
      logger: capture.logger,
    });

    expect(handle).toEqual({
      processType: TELEMETRY_PROCESS_TYPE.WORKER,
      status: ERROR_MONITORING_STATUS.STARTED,
    });
    expect(capture.entries()[0]).toEqual(
      expect.objectContaining({
        msg: "error_monitoring.started",
        processType: "worker",
      }),
    );
    expect(capture.raw()).not.toContain("public-key");
  });

  it("captures without throwing and without awaiting a network call", async () => {
    await startErrorMonitor({ processType: TELEMETRY_PROCESS_TYPE.WEB });

    expect(
      captureUnexpectedError(new InternalError("defect"), {
        boundary: ERROR_BOUNDARY.ROUTE,
        operationName: "identity.user.list",
        errorCode: "INTERNAL_ERROR",
        requestId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    ).toBeUndefined();
  });

  it("flushes and shuts down within a bounded budget", async () => {
    await startErrorMonitor({ processType: TELEMETRY_PROCESS_TYPE.WORKER });

    captureUnexpectedError(new InternalError("defect"), {
      boundary: ERROR_BOUNDARY.JOB,
      jobName: "mail.send",
      jobVersion: 1,
    });

    await expect(flushErrorMonitor(200)).resolves.toBeUndefined();
    await expect(shutdownErrorMonitor()).resolves.toBeUndefined();
    expect(errorMonitorStatus()).toBe(ERROR_MONITORING_STATUS.STOPPED);
  });

  it("does not shut down twice", async () => {
    await startErrorMonitor({ processType: TELEMETRY_PROCESS_TYPE.WEB });

    const first = shutdownErrorMonitor();
    const second = shutdownErrorMonitor();

    expect(first).toBe(second);
    await first;
  });

  it("returns to a no-op after shutdown", async () => {
    await startErrorMonitor({ processType: TELEMETRY_PROCESS_TYPE.WEB });
    await shutdownErrorMonitor();

    expect(() =>
      captureUnexpectedError(new InternalError("defect"), {
        boundary: ERROR_BOUNDARY.ROUTE,
      }),
    ).not.toThrow();
  });
});
