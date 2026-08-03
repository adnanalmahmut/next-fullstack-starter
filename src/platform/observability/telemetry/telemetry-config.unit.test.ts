import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getTelemetryConfiguration,
  isTelemetryEnabled,
  resetTelemetryConfiguration,
  TELEMETRY_SERVICE_NAME,
} from "./telemetry-config";
import { TELEMETRY_STATUS } from "./telemetry-status";

const ENDPOINT = "https://collector.example.com:4318";

beforeEach(() => {
  resetTelemetryConfiguration();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetTelemetryConfiguration();
});

describe("the disabled default", () => {
  it("answers disabled when nothing is configured", () => {
    const configuration = getTelemetryConfiguration();

    expect(configuration).toEqual({
      enabled: false,
      status: TELEMETRY_STATUS.DISABLED,
    });
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("caches the answer, so the environment is read once", () => {
    expect(getTelemetryConfiguration()).toBe(getTelemetryConfiguration());
  });

  it("forgets the answer when reset", () => {
    const first = getTelemetryConfiguration();

    resetTelemetryConfiguration();

    expect(getTelemetryConfiguration()).not.toBe(first);
  });
});

describe("an enabled, valid configuration", () => {
  beforeEach(() => {
    vi.stubEnv("TELEMETRY_ENABLED", "true");
    vi.stubEnv("TELEMETRY_OTLP_ENDPOINT", ENDPOINT);
    resetTelemetryConfiguration();
  });

  it("derives an explicit URL for each signal", () => {
    const configuration = getTelemetryConfiguration();

    expect(configuration.enabled).toBe(true);

    if (!configuration.enabled) {
      return;
    }

    // Always explicit, so the exporter can never fall back to its own
    // `localhost:4318` default.
    expect(configuration.traceEndpoint).toBe(`${ENDPOINT}/v1/traces`);
    expect(configuration.metricEndpoint).toBe(`${ENDPOINT}/v1/metrics`);
  });

  it("does not double a trailing slash on the endpoint", () => {
    vi.stubEnv("TELEMETRY_OTLP_ENDPOINT", `${ENDPOINT}/`);
    resetTelemetryConfiguration();

    const configuration = getTelemetryConfiguration();

    expect(configuration.enabled ? configuration.traceEndpoint : null).toBe(
      `${ENDPOINT}/v1/traces`,
    );
  });

  it("uses the fixed service name the logger already stamps", () => {
    const configuration = getTelemetryConfiguration();

    expect(configuration.enabled ? configuration.serviceName : null).toBe(
      TELEMETRY_SERVICE_NAME,
    );
    expect(TELEMETRY_SERVICE_NAME).toBe("next-fullstack-starter");
  });

  it("keeps every trace outside production", () => {
    const configuration = getTelemetryConfiguration();

    // `APP_ENV` is `test` in this suite. A developer looking for one request must
    // not be told it was sampled away.
    expect(configuration.enabled ? configuration.traceSampleRatio : null).toBe(
      1,
    );
  });

  it("honours an explicit sampling ratio", () => {
    vi.stubEnv("TELEMETRY_TRACE_SAMPLE_RATIO", "0.25");
    resetTelemetryConfiguration();

    const configuration = getTelemetryConfiguration();

    expect(configuration.enabled ? configuration.traceSampleRatio : null).toBe(
      0.25,
    );
  });

  it("carries no release when none is set", () => {
    const configuration = getTelemetryConfiguration();

    expect(
      configuration.enabled ? configuration.serviceVersion : "unset",
    ).toBeUndefined();
  });

  it("carries the release when one is set", () => {
    vi.stubEnv("APP_RELEASE", "1.2.3");
    resetTelemetryConfiguration();

    const configuration = getTelemetryConfiguration();

    expect(configuration.enabled ? configuration.serviceVersion : null).toBe(
      "1.2.3",
    );
  });

  it("parses the header credential into a frozen map", () => {
    vi.stubEnv("TELEMETRY_OTLP_HEADERS", "Authorization=Bearer-token");
    resetTelemetryConfiguration();

    const configuration = getTelemetryConfiguration();
    const headers = configuration.enabled ? configuration.headers : undefined;

    expect(headers).toEqual({ authorization: "Bearer-token" });
    expect(Object.isFrozen(headers)).toBe(true);
  });
});

describe("an invalid configuration degrades rather than failing", () => {
  it.each([
    {
      name: "a malformed endpoint",
      variable: "TELEMETRY_OTLP_ENDPOINT",
      value: "not-a-url",
    },
    {
      name: "credentials in the endpoint",
      variable: "TELEMETRY_OTLP_ENDPOINT",
      value: "https://user:secret@collector.example.com:4318",
    },
    {
      name: "an out-of-range sampling ratio",
      variable: "TELEMETRY_TRACE_SAMPLE_RATIO",
      value: "5",
    },
    {
      name: "an out-of-range export interval",
      variable: "TELEMETRY_METRIC_EXPORT_INTERVAL_MS",
      value: "1",
    },
  ])("classifies $name as invalid and never throws", ({ variable, value }) => {
    vi.stubEnv("TELEMETRY_ENABLED", "true");
    vi.stubEnv("TELEMETRY_OTLP_ENDPOINT", ENDPOINT);
    vi.stubEnv(variable, value);
    resetTelemetryConfiguration();

    expect(getTelemetryConfiguration()).toEqual({
      enabled: false,
      status: TELEMETRY_STATUS.INVALID_CONFIGURATION,
    });
  });

  it("classifies an enabled configuration with no endpoint as invalid", () => {
    vi.stubEnv("TELEMETRY_ENABLED", "true");
    resetTelemetryConfiguration();

    expect(getTelemetryConfiguration().enabled).toBe(false);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("classifies a malformed header list as invalid without holding it", () => {
    vi.stubEnv("TELEMETRY_ENABLED", "true");
    vi.stubEnv("TELEMETRY_OTLP_ENDPOINT", ENDPOINT);
    vi.stubEnv("TELEMETRY_OTLP_HEADERS", "authorization=Bearer secret-token");
    resetTelemetryConfiguration();

    const configuration = getTelemetryConfiguration();

    expect(configuration.enabled).toBe(false);
    expect(JSON.stringify(configuration)).not.toContain("secret-token");
  });

  it("never reports the endpoint or the headers in its answer", () => {
    vi.stubEnv("TELEMETRY_ENABLED", "true");
    vi.stubEnv("TELEMETRY_OTLP_ENDPOINT", "not-a-url");
    resetTelemetryConfiguration();

    const configuration = getTelemetryConfiguration();

    expect(Object.keys(configuration).sort()).toEqual(["enabled", "status"]);
  });
});
