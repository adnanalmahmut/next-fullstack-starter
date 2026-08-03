import { describe, expect, it } from "vitest";

import {
  errorMonitoringEnvironmentSchema,
  MAX_SENTRY_DSN_LENGTH,
} from "./schema";

const DSN = "https://public-key@o1.ingest.example.com/42";

function parse(values: Record<string, string>) {
  return errorMonitoringEnvironmentSchema.safeParse(values);
}

describe("the disabled default", () => {
  it("accepts an environment with no error-monitoring variable at all", () => {
    const result = parse({});

    expect(result.success).toBe(true);
    expect(result.data?.ERROR_MONITORING_ENABLED).toBe(false);
  });

  it("requires no DSN while error monitoring is off", () => {
    expect(parse({ ERROR_MONITORING_ENABLED: "false" }).success).toBe(true);
  });

  it("refuses an unknown variable", () => {
    expect(parse({ SENTRY_TRACES_SAMPLE_RATE: "1" }).success).toBe(false);
  });

  it("is independent of telemetry, and names no telemetry variable", () => {
    // The two areas are separate switches on purpose: a deployment may want error
    // reports with no collector, or a collector with no vendor.
    expect(parse({ TELEMETRY_ENABLED: "true" }).success).toBe(false);
  });
});

describe("the enabled contract", () => {
  it("requires a DSN", () => {
    const result = parse({ ERROR_MONITORING_ENABLED: "true" });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["SENTRY_DSN"]);
  });

  it("accepts a well-formed DSN", () => {
    const result = parse({
      ERROR_MONITORING_ENABLED: "true",
      SENTRY_DSN: DSN,
    });

    expect(result.success).toBe(true);
    expect(result.data?.SENTRY_DSN).toBe(DSN);
  });

  it.each([
    { name: "no public key", value: "https://o1.ingest.example.com/42" },
    {
      name: "no project id",
      value: "https://public-key@o1.ingest.example.com",
    },
    { name: "a password", value: "https://key:secret@o1.example.com/42" },
    { name: "not a URL", value: "public-key@example.com" },
    { name: "an unsupported scheme", value: "ftp://key@example.com/42" },
    { name: "an empty value", value: "" },
  ])("refuses a DSN with $name", ({ value }) => {
    expect(
      parse({ ERROR_MONITORING_ENABLED: "true", SENTRY_DSN: value }).success,
    ).toBe(false);
  });

  it("refuses a DSN longer than the bound", () => {
    const long = `https://${"k".repeat(MAX_SENTRY_DSN_LENGTH)}@example.com/1`;

    expect(
      parse({ ERROR_MONITORING_ENABLED: "true", SENTRY_DSN: long }).success,
    ).toBe(false);
  });

  it("never echoes the DSN in a validation error", () => {
    const secret = "extremely-secret-public-key";
    const result = parse({
      ERROR_MONITORING_ENABLED: "true",
      SENTRY_DSN: `not-a-dsn-${secret}`,
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(secret);
  });
});
