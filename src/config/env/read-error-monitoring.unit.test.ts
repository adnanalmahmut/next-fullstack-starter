import { describe, expect, it } from "vitest";

import { readErrorMonitoringEnvironment } from "./read-error-monitoring";

const DSN = "https://public-key@o1.ingest.example.com/42";

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

describe("reading a disabled error-monitoring configuration", () => {
  it("answers disabled for a source with no variable at all", () => {
    expect(readErrorMonitoringEnvironment({}).ERROR_MONITORING_ENABLED).toBe(
      false,
    );
  });

  it("never reads the DSN", () => {
    const { source, reads } = recordingSource({
      ERROR_MONITORING_ENABLED: "false",
      SENTRY_DSN: DSN,
      APP_RELEASE: "1.0.0",
    });

    expect(
      readErrorMonitoringEnvironment(source).ERROR_MONITORING_ENABLED,
    ).toBe(false);
    expect(reads).toEqual(["ERROR_MONITORING_ENABLED"]);
  });

  it("ignores a malformed DSN left behind while disabled", () => {
    expect(
      readErrorMonitoringEnvironment({
        ERROR_MONITORING_ENABLED: "false",
        SENTRY_DSN: "not-a-dsn",
      }).ERROR_MONITORING_ENABLED,
    ).toBe(false);
  });

  it("still refuses a flag that is neither true nor false", () => {
    expect(() =>
      readErrorMonitoringEnvironment({ ERROR_MONITORING_ENABLED: "on" }),
    ).toThrow(/error monitoring/i);
  });
});

describe("reading an enabled error-monitoring configuration", () => {
  it("reads the DSN and the release", () => {
    const values = readErrorMonitoringEnvironment({
      ERROR_MONITORING_ENABLED: "true",
      SENTRY_DSN: DSN,
      APP_RELEASE: "4.5.6",
    });

    expect(values).toEqual({
      ERROR_MONITORING_ENABLED: true,
      SENTRY_DSN: DSN,
      APP_RELEASE: "4.5.6",
    });
  });

  it("refuses an enabled configuration with no DSN", () => {
    expect(() =>
      readErrorMonitoringEnvironment({ ERROR_MONITORING_ENABLED: "true" }),
    ).toThrow(/SENTRY_DSN/);
  });

  it("is independent of the telemetry switch", () => {
    const values = readErrorMonitoringEnvironment({
      TELEMETRY_ENABLED: "true",
      ERROR_MONITORING_ENABLED: "false",
    });

    expect(values.ERROR_MONITORING_ENABLED).toBe(false);
  });
});
