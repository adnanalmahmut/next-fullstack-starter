import { describe, expect, it } from "vitest";

import { readTelemetryEnvironment } from "./read-telemetry";

const ENDPOINT = "https://collector.example.com:4318";

/**
 * A source that records every name it was asked for.
 *
 * It is the whole point of the disabled-path test below: the assertion is not that
 * the sensitive values were ignored, but that they were never *read*. A disabled
 * application has no business holding an OTLP header credential in memory.
 */
function recordingSource(values: Record<string, string | undefined>) {
  const reads: string[] = [];

  const source = new Proxy(values, {
    get(target, property) {
      if (typeof property === "string") {
        reads.push(property);
      }

      return Reflect.get(target, property);
    },
  }) as Readonly<Record<string, string | undefined>>;

  return { source, reads };
}

describe("reading a disabled telemetry configuration", () => {
  it("answers disabled for a source with no telemetry variable", () => {
    expect(readTelemetryEnvironment({}).TELEMETRY_ENABLED).toBe(false);
  });

  it("never reads the endpoint or the header credential", () => {
    const { source, reads } = recordingSource({
      TELEMETRY_ENABLED: "false",
      TELEMETRY_OTLP_ENDPOINT: ENDPOINT,
      TELEMETRY_OTLP_HEADERS: "authorization=Bearer-secret",
      APP_RELEASE: "1.0.0",
    });

    expect(readTelemetryEnvironment(source).TELEMETRY_ENABLED).toBe(false);
    expect(reads).toEqual(["TELEMETRY_ENABLED"]);
  });

  it("ignores a malformed endpoint that is left behind while disabled", () => {
    // A variable nobody removed after switching telemetry off must not be able to
    // stop the application booting.
    expect(
      readTelemetryEnvironment({
        TELEMETRY_ENABLED: "false",
        TELEMETRY_OTLP_ENDPOINT: "not-a-url",
      }).TELEMETRY_ENABLED,
    ).toBe(false);
  });

  it("still refuses a flag that is neither true nor false", () => {
    expect(() =>
      readTelemetryEnvironment({ TELEMETRY_ENABLED: "maybe" }),
    ).toThrow(/telemetry/i);
  });
});

describe("reading an enabled telemetry configuration", () => {
  it("reads every enabled variable", () => {
    const { source, reads } = recordingSource({
      TELEMETRY_ENABLED: "true",
      TELEMETRY_OTLP_ENDPOINT: ENDPOINT,
      TELEMETRY_OTLP_HEADERS: "authorization=Bearer-secret",
      TELEMETRY_TRACE_SAMPLE_RATIO: "0.25",
      TELEMETRY_METRIC_EXPORT_INTERVAL_MS: "5000",
      TELEMETRY_EXPORT_TIMEOUT_MS: "1500",
      APP_RELEASE: "1.2.3",
    });
    const values = readTelemetryEnvironment(source);

    expect(values).toEqual({
      TELEMETRY_ENABLED: true,
      TELEMETRY_OTLP_ENDPOINT: ENDPOINT,
      TELEMETRY_OTLP_HEADERS: "authorization=Bearer-secret",
      TELEMETRY_TRACE_SAMPLE_RATIO: 0.25,
      TELEMETRY_METRIC_EXPORT_INTERVAL_MS: 5000,
      TELEMETRY_EXPORT_TIMEOUT_MS: 1500,
      APP_RELEASE: "1.2.3",
    });
    expect(reads).toContain("TELEMETRY_OTLP_ENDPOINT");
  });

  it("omits an absent variable rather than overwriting its default", () => {
    const values = readTelemetryEnvironment({
      TELEMETRY_ENABLED: "true",
      TELEMETRY_OTLP_ENDPOINT: ENDPOINT,
    });

    expect(values.TELEMETRY_METRIC_EXPORT_INTERVAL_MS).toBeGreaterThan(0);
    expect(values.TELEMETRY_OTLP_HEADERS).toBeUndefined();
  });

  it("refuses an enabled configuration with no endpoint", () => {
    expect(() =>
      readTelemetryEnvironment({ TELEMETRY_ENABLED: "true" }),
    ).toThrow(/TELEMETRY_OTLP_ENDPOINT/);
  });
});
