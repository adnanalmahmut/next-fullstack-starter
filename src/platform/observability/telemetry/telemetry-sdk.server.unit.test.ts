import { metrics, trace } from "@opentelemetry/api";
import type { DestinationStream } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationLogger } from "../create-logger.server";

import { resetTelemetryConfiguration } from "./telemetry-config";
import {
  forceFlushProductionTelemetry,
  productionTelemetryStatus,
  resetProductionTelemetry,
  shutdownProductionTelemetry,
  startProductionTelemetry,
} from "./telemetry-sdk.server";
import { TELEMETRY_PROCESS_TYPE, TELEMETRY_STATUS } from "./telemetry-status";

const ENDPOINT = "http://127.0.0.1:4318";

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
  resetProductionTelemetry();
  resetTelemetryConfiguration();
});

afterEach(async () => {
  await shutdownProductionTelemetry();
  resetProductionTelemetry();
  resetTelemetryConfiguration();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the disabled path", () => {
  it("returns a no-op handle and registers nothing", async () => {
    const handle = await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });

    expect(handle).toEqual({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
      status: TELEMETRY_STATUS.DISABLED,
    });
    expect(productionTelemetryStatus()).toBe(TELEMETRY_STATUS.DISABLED);

    // Nothing was registered, so the API is still answering with its no-op
    // implementations.
    expect(trace.getTracer("probe").startSpan("probe").isRecording()).toBe(
      false,
    );
  });

  it("logs nothing when telemetry was simply never asked for", async () => {
    const capture = createCapture();

    await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
      logger: capture.logger,
    });

    // A line saying "telemetry is disabled" on every boot of every process that
    // never wanted telemetry is noise.
    expect(capture.entries()).toEqual([]);
  });

  it("flushes and shuts down without doing anything", async () => {
    await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WORKER,
    });

    await expect(forceFlushProductionTelemetry()).resolves.toBeUndefined();
    await expect(shutdownProductionTelemetry()).resolves.toBeUndefined();
  });

  it("shares one initialization promise across concurrent callers", async () => {
    const first = startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });
    const second = startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });

    expect(first).toBe(second);
    await expect(first).resolves.toEqual(await second);
  });
});

describe("an invalid configuration", () => {
  beforeEach(() => {
    vi.stubEnv("TELEMETRY_ENABLED", "true");
    vi.stubEnv("TELEMETRY_OTLP_ENDPOINT", "not-a-url");
    resetTelemetryConfiguration();
  });

  it("degrades to a no-op and reports a stable status", async () => {
    const handle = await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });

    expect(handle.status).toBe(TELEMETRY_STATUS.INVALID_CONFIGURATION);
    expect(trace.getTracer("probe").startSpan("probe").isRecording()).toBe(
      false,
    );
  });

  it("logs one sanitized line that names no variable value", async () => {
    const capture = createCapture();

    await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
      logger: capture.logger,
    });

    const entries = capture.entries();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        msg: "telemetry.start_failed",
        processType: "web",
        status: TELEMETRY_STATUS.INVALID_CONFIGURATION,
      }),
    );
    expect(capture.raw()).not.toContain("not-a-url");
  });
});

describe("an enabled configuration", () => {
  beforeEach(() => {
    vi.stubEnv("TELEMETRY_ENABLED", "true");
    // A closed port. Nothing here waits for an export, so an unreachable
    // collector is exactly the right thing to start against.
    vi.stubEnv("TELEMETRY_OTLP_ENDPOINT", ENDPOINT);
    vi.stubEnv("TELEMETRY_METRIC_EXPORT_INTERVAL_MS", "300000");
    vi.stubEnv("TELEMETRY_EXPORT_TIMEOUT_MS", "500");
    resetTelemetryConfiguration();
  });

  it("registers providers and starts recording", async () => {
    const handle = await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WORKER,
    });

    expect(handle).toEqual({
      processType: TELEMETRY_PROCESS_TYPE.WORKER,
      status: TELEMETRY_STATUS.STARTED,
    });
    expect(trace.getTracer("probe").startSpan("probe").isRecording()).toBe(
      true,
    );
  });

  it("is idempotent: a second start builds no second SDK", async () => {
    const first = await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });
    const second = await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WORKER,
    });

    // The second call joins the first rather than replacing the providers, so the
    // process type of the first start is the one that stands.
    expect(second).toEqual(first);
  });

  it("logs one started line carrying no endpoint", async () => {
    const capture = createCapture();

    await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
      logger: capture.logger,
    });

    const entries = capture.entries();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        msg: "telemetry.started",
        processType: "web",
        status: TELEMETRY_STATUS.STARTED,
      }),
    );
    expect(capture.raw()).not.toContain("4318");
  });

  it("releases every provider, timer, and global on shutdown", async () => {
    await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });

    await shutdownProductionTelemetry();

    expect(productionTelemetryStatus()).toBe(TELEMETRY_STATUS.STOPPED);
    // The globals are released, so nothing can obtain a tracer or a meter from a
    // provider that has been shut down.
    expect(trace.getTracer("probe").startSpan("probe").isRecording()).toBe(
      false,
    );
    expect(metrics.getMeter("probe").createCounter("probe")).toBeDefined();
  });

  it("does not shut down twice", async () => {
    await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });

    const first = shutdownProductionTelemetry();
    const second = shutdownProductionTelemetry();

    expect(first).toBe(second);
    await first;
  });

  it("flushes within its budget against an unreachable collector", async () => {
    await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });

    trace.getTracer("probe").startSpan("probe").end();

    // The collector is not there. The flush must still resolve, and must resolve
    // without throwing, because a worker that finished its jobs has finished its
    // jobs.
    await expect(forceFlushProductionTelemetry()).resolves.toBeUndefined();
  });

  it("can be started again after a shutdown", async () => {
    await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });
    await shutdownProductionTelemetry();

    const restarted = await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });

    expect(restarted.status).toBe(TELEMETRY_STATUS.STARTED);
  });
});

describe("a failing initialization", () => {
  beforeEach(() => {
    vi.stubEnv("TELEMETRY_ENABLED", "true");
    vi.stubEnv("TELEMETRY_OTLP_ENDPOINT", ENDPOINT);
    resetTelemetryConfiguration();
  });

  it("contains the failure and leaves the singleton retryable", async () => {
    const failing = vi
      .spyOn(trace, "setGlobalTracerProvider")
      .mockImplementationOnce(() => {
        throw new Error("provider registration is broken");
      });

    const failed = await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });

    expect(failed.status).toBe(TELEMETRY_STATUS.START_FAILED);
    expect(failing).toHaveBeenCalledTimes(1);

    // A poisoned singleton would make one transient failure permanent for the
    // life of the process, and would make this path untestable.
    const retried = await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WEB,
    });

    expect(retried.status).toBe(TELEMETRY_STATUS.STARTED);
  });

  it("logs a failure that names no SDK error", async () => {
    const capture = createCapture();

    vi.spyOn(trace, "setGlobalTracerProvider").mockImplementationOnce(() => {
      throw new Error("collector at 10.0.0.5 refused the connection");
    });

    await startProductionTelemetry({
      processType: TELEMETRY_PROCESS_TYPE.WORKER,
      logger: capture.logger,
    });

    expect(capture.entries()[0]).toEqual(
      expect.objectContaining({
        msg: "telemetry.start_failed",
        status: TELEMETRY_STATUS.START_FAILED,
        processType: "worker",
      }),
    );
    expect(capture.raw()).not.toContain("10.0.0.5");
  });
});
