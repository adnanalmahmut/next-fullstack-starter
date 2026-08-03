import type { DestinationStream } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplicationLogger } from "./create-logger.server";
import { resetErrorMonitor } from "./error-monitoring/error-monitor.server";
import { ERROR_MONITORING_STATUS } from "./error-monitoring/error-monitoring-config";
import {
  registerObservability,
  resetObservabilityRegistration,
} from "./register-observability.server";
import { resetProductionTelemetry } from "./telemetry/telemetry-sdk.server";
import {
  TELEMETRY_PROCESS_TYPE,
  TELEMETRY_STATUS,
} from "./telemetry/telemetry-status";

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
      level: "info",
      destination,
    }),
    entries: () =>
      output.map((message) => JSON.parse(message) as Record<string, unknown>),
  };
}

beforeEach(() => {
  resetObservabilityRegistration();
  resetProductionTelemetry();
  resetErrorMonitor();
});

afterEach(() => {
  resetObservabilityRegistration();
  resetProductionTelemetry();
  resetErrorMonitor();
});

describe("observability registration", () => {
  it("emits the startup event only once", async () => {
    const capture = createCapture();

    await registerObservability(capture.logger);
    await registerObservability(capture.logger);

    expect(capture.entries()).toHaveLength(1);
    expect(capture.entries()[0]).toEqual(
      expect.objectContaining({ msg: "application.started" }),
    );
  });

  it("reports both optional areas as disabled by default", async () => {
    const capture = createCapture();
    const registration = await registerObservability(capture.logger);

    // The default deployment has no collector and no vendor, and registration is
    // still complete: the whole optionality contract in one assertion.
    expect(registration).toEqual({
      telemetry: {
        processType: TELEMETRY_PROCESS_TYPE.WEB,
        status: TELEMETRY_STATUS.DISABLED,
      },
      errorMonitoring: {
        processType: TELEMETRY_PROCESS_TYPE.WEB,
        status: ERROR_MONITORING_STATUS.DISABLED,
      },
    });
  });

  it("shares one registration across concurrent callers", () => {
    const capture = createCapture();
    const first = registerObservability(capture.logger);
    const second = registerObservability(capture.logger);

    expect(first).toBe(second);

    return first;
  });

  it("registers for the web process type", async () => {
    const capture = createCapture();
    const registration = await registerObservability(capture.logger);

    // The worker registers for itself, in its own entry point, because it is a
    // process and a process owns its own lifecycle.
    expect(registration.telemetry.processType).toBe(TELEMETRY_PROCESS_TYPE.WEB);
  });
});
